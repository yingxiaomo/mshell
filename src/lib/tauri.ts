import { invoke } from "@tauri-apps/api/core";
import type { Connection } from "../types/protocol";

export function listConnections() {
  return invoke<Connection[]>("list_connections");
}

export function saveConnection(
  conn: Connection,
  password?: string,
  passphrase?: string,
) {
  return invoke<Connection>("save_connection", {
    conn,
    password: password ?? null,
    passphrase: passphrase ?? null,
  });
}

export function deleteConnection(id: string) {
  return invoke<void>("delete_connection", { id });
}
