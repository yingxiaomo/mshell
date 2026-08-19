#!/usr/bin/env python3
"""Minimal real SSH server (paramiko) for testing mshell's ssh-core.

Supports: publickey auth, PTY+shell (echo), exec, SFTP (rooted at a temp dir),
and direct-tcpip local forwarding (relays to the requested host:port).

Prints one JSON line `{"ssh_port": N, "echo_port": M}` to stdout when ready.
Also maintains a connection counter file so tests can assert that SFTP/tunnels
open their own separate SSH connections.
"""
import argparse
import base64
import json
import os
import socket
import sys
import threading
import time

import paramiko

# ----------------------------------------------------------------------------
CONN_COUNT = 0
CONN_LOCK = threading.Lock()


def load_pubkey(path):
    with open(path) as f:
        parts = f.read().split()
    typ, b64 = parts[0], parts[1]
    data = base64.b64decode(b64)
    if typ == "ssh-rsa":
        return paramiko.RSAKey(data=data)
    if typ == "ssh-ed25519":
        return paramiko.Ed25519Key(data=data)
    if typ.startswith("ecdsa-"):
        return paramiko.ECDSAKey(data=data)
    raise ValueError("unsupported key type: " + typ)


# --- SFTP -------------------------------------------------------------------
class StubSFTPHandle(paramiko.SFTPHandle):
    def __init__(self, flags=0):
        super().__init__(flags)
        self.readfile = None
        self.writefile = None

    def stat(self):
        try:
            return paramiko.SFTPAttributes.from_stat(os.fstat(self.readfile.fileno()))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def close(self):
        if self.readfile:
            self.readfile.close()
        if self.writefile:
            self.writefile.close()


class StubSFTPServer(paramiko.SFTPServerInterface):
    ROOT = "."

    def _real(self, path):
        p = os.path.normpath(os.path.join(self.ROOT, path.lstrip("/")))
        return p

    def list_folder(self, path):
        rpath = self._real(path)
        try:
            out = []
            for fname in os.listdir(rpath):
                attr = paramiko.SFTPAttributes.from_stat(os.stat(os.path.join(rpath, fname)))
                attr.filename = fname
                out.append(attr)
            return out
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def stat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(os.stat(self._real(path)))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def lstat(self, path):
        try:
            return paramiko.SFTPAttributes.from_stat(os.lstat(self._real(path)))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)

    def open(self, path, flags, attr):
        rpath = self._real(path)
        try:
            binary = getattr(os, "O_BINARY", 0)
            fd = os.open(rpath, flags | binary)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        if flags & os.O_WRONLY or flags & os.O_RDWR:
            mode = "r+b" if (flags & os.O_RDWR) else "wb"
            if flags & os.O_APPEND:
                mode = "ab"
        else:
            mode = "rb"
        try:
            f = os.fdopen(fd, mode)
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        h = StubSFTPHandle(flags)
        h.filename = rpath
        h.readfile = f
        h.writefile = f
        return h

    def remove(self, path):
        try:
            os.remove(self._real(path))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def rename(self, oldpath, newpath):
        try:
            os.replace(self._real(oldpath), self._real(newpath))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def mkdir(self, path, attr):
        try:
            os.mkdir(self._real(path))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def rmdir(self, path):
        try:
            os.rmdir(self._real(path))
        except OSError as e:
            return paramiko.SFTPServer.convert_errno(e.errno)
        return paramiko.SFTP_OK

    def chattr(self, path, attr):
        return paramiko.SFTP_OK

    def canonicalize(self, path):
        # Map everything under the fake root "/".
        if path in ("", "."):
            return "/"
        if not path.startswith("/"):
            path = "/" + path
        return os.path.normpath(path).replace("\\", "/")


# --- shell / exec / relay ---------------------------------------------------
def echo_shell(chan):
    try:
        chan.send(b"mshell-test-shell\r\n")
        while True:
            data = chan.recv(4096)
            if not data:
                break
            chan.send(data)  # echo back
            if b"exit" in data:
                # Simulate the remote shell process exiting so the client's
                # worker sees channel EOF (tests the shell-close teardown path).
                chan.send_exit_status(0)
                break
    except Exception:
        pass
    finally:
        try:
            chan.close()
        except Exception:
            pass


def run_exec(chan, command):
    try:
        if isinstance(command, bytes):
            command = command.decode("utf-8", "replace")
        # Echo a deterministic response so tests can assert.
        chan.send(("EXEC:" + command + "\n").encode())
        chan.send_exit_status(0)
    except Exception:
        pass
    finally:
        try:
            chan.close()
        except Exception:
            pass


def relay(chan, dest):
    host, port = dest
    try:
        sock = socket.create_connection((host, port), timeout=10)
    except Exception:
        chan.close()
        return

    def pump(src, dst, is_sock):
        try:
            while True:
                data = src.recv(4096)
                if not data:
                    break
                dst.sendall(data) if is_sock else dst.send(data)
        except Exception:
            pass
        finally:
            try:
                dst.close()
            except Exception:
                pass
            try:
                src.close()
            except Exception:
                pass

    threading.Thread(target=pump, args=(chan, sock, True), daemon=True).start()
    threading.Thread(target=pump, args=(sock, chan, False), daemon=True).start()


class Server(paramiko.ServerInterface):
    def __init__(self, authorized):
        self.authorized = authorized
        self.tcpip_dests = {}

    def check_auth_publickey(self, username, key):
        if key.asbytes() == self.authorized.asbytes():
            return paramiko.AUTH_SUCCESSFUL
        return paramiko.AUTH_FAILED

    def check_auth_password(self, username, password):
        return paramiko.AUTH_FAILED

    def get_allowed_auths(self, username):
        return "publickey"

    def check_channel_request(self, kind, chanid):
        if kind in ("session", "direct-tcpip"):
            return paramiko.OPEN_SUCCEEDED
        return paramiko.OPEN_FAILED_ADMINISTRATIVELY_PROHIBITED

    def check_channel_pty_request(self, ch, term, w, h, pw, ph, modes):
        return True

    def check_channel_shell_request(self, channel):
        threading.Thread(target=echo_shell, args=(channel,), daemon=True).start()
        return True

    def check_channel_exec_request(self, channel, command):
        threading.Thread(target=run_exec, args=(channel, command), daemon=True).start()
        return True

    def check_channel_direct_tcpip_request(self, chanid, origin, destination):
        self.tcpip_dests[chanid] = destination
        return paramiko.OPEN_SUCCEEDED


def handle_conn(client, host_key, authorized, count_file):
    global CONN_COUNT
    with CONN_LOCK:
        CONN_COUNT += 1
        try:
            with open(count_file, "w") as f:
                f.write(str(CONN_COUNT))
        except Exception:
            pass
    try:
        t = paramiko.Transport(client)
        t.add_server_key(host_key)
        t.set_subsystem_handler("sftp", paramiko.SFTPServer, StubSFTPServer)
        server = Server(authorized)
        t.start_server(server=server)
        while t.is_active():
            chan = t.accept(1)
            if chan is None:
                continue
            cid = chan.get_id()
            if cid in server.tcpip_dests:
                dest = server.tcpip_dests.pop(cid)
                relay(chan, dest)
            # session channels handled by request callbacks
    except Exception:
        pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--authkey", required=True)
    ap.add_argument("--root", required=True)
    ap.add_argument("--count-file", required=True)
    args = ap.parse_args()

    StubSFTPServer.ROOT = args.root
    authorized = load_pubkey(args.authkey)
    host_key = paramiko.RSAKey.generate(2048)

    # SSH listener
    ssh_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    ssh_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ssh_sock.bind(("127.0.0.1", 0))
    ssh_sock.listen(16)
    ssh_port = ssh_sock.getsockname()[1]

    # Built-in TCP echo server (used as the tunnel forward target)
    echo_sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    echo_sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    echo_sock.bind(("127.0.0.1", 0))
    echo_sock.listen(16)
    echo_port = echo_sock.getsockname()[1]

    def echo_accept():
        while True:
            try:
                c, _ = echo_sock.accept()
            except Exception:
                break
            def serve(cc):
                try:
                    while True:
                        d = cc.recv(4096)
                        if not d:
                            break
                        cc.sendall(b"ECHO:" + d)
                except Exception:
                    pass
                finally:
                    try:
                        cc.close()
                    except Exception:
                        pass
            threading.Thread(target=serve, args=(c,), daemon=True).start()

    threading.Thread(target=echo_accept, daemon=True).start()

    print(json.dumps({"ssh_port": ssh_port, "echo_port": echo_port}), flush=True)

    while True:
        try:
            client, _ = ssh_sock.accept()
        except Exception:
            break
        threading.Thread(
            target=handle_conn,
            args=(client, host_key, authorized, args.count_file),
            daemon=True,
        ).start()


if __name__ == "__main__":
    main()
