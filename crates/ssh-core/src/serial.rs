//! Serial port (COM) terminal session.
//!
//! Uses `serialport` crate to open a COM port with configurable baud / data bits /
//! stop bits / parity, then relays raw bytes the same way Telnet and local sessions do.

use std::io::{Read, Write};
use std::time::Duration;

use protocol::SerialConfig;

use crate::error::CoreError;

/// Wraps a serial port with byte-level read/write.
pub struct SerialSession {
    port: Box<dyn serialport::SerialPort>,
}

impl SerialSession {
    /// Open a serial port with the given config and timeout.
    pub fn open(config: &SerialConfig, timeout: Duration) -> Result<Self, CoreError> {
        if config.port_name.trim().is_empty() {
            return Err(CoreError::Other("串口名称不能为空".into()));
        }

        let mut builder = serialport::new(&config.port_name, config.baud_rate)
            // Short read timeout so the session poll loop stays responsive.
            .timeout(Duration::from_millis(50).min(timeout));

        match config.data_bits {
            5 => {
                builder = builder.data_bits(serialport::DataBits::Five);
            }
            6 => {
                builder = builder.data_bits(serialport::DataBits::Six);
            }
            7 => {
                builder = builder.data_bits(serialport::DataBits::Seven);
            }
            8 => {
                builder = builder.data_bits(serialport::DataBits::Eight);
            }
            _ => {
                builder = builder.data_bits(serialport::DataBits::Eight);
            }
        }

        builder = builder.stop_bits(match config.stop_bits.as_str() {
            "2" => serialport::StopBits::Two,
            // Prefer One for 1.5 on platforms without OnePointFive.
            "1.5" => serialport::StopBits::One,
            _ => serialport::StopBits::One,
        });

        builder = builder.parity(match config.parity.as_str() {
            "odd" => serialport::Parity::Odd,
            "even" => serialport::Parity::Even,
            _ => serialport::Parity::None,
        });

        let port = builder
            .open()
            .map_err(|e| CoreError::Other(format!("打开串口 {} 失败: {e}", config.port_name)))?;

        Ok(Self { port })
    }

    /// Write bytes to the serial port.
    pub fn write(&mut self, data: &[u8]) -> Result<(), CoreError> {
        self.port.write_all(data)?;
        self.port.flush()?;
        Ok(())
    }

    /// Read available bytes (returns `None` on timeout / would-block).
    pub fn try_read(&mut self, buf: &mut [u8]) -> Result<Option<usize>, CoreError> {
        match self.port.read(buf) {
            Ok(0) => Ok(None),
            Ok(n) => Ok(Some(n)),
            Err(e)
                if e.kind() == std::io::ErrorKind::TimedOut
                    || e.kind() == std::io::ErrorKind::WouldBlock =>
            {
                Ok(None)
            }
            Err(e) => Err(CoreError::Io(e)),
        }
    }

    /// Close the serial port (drop RTS/DTR best-effort).
    pub fn close(&mut self) -> Result<(), CoreError> {
        let _ = self.port.write_data_terminal_ready(false);
        let _ = self.port.write_request_to_send(false);
        Ok(())
    }
}

/// List available serial ports for the UI.
pub fn list_ports() -> Result<Vec<String>, CoreError> {
    let ports = serialport::available_ports()
        .map_err(|e| CoreError::Other(format!("枚举串口失败: {e}")))?;
    let mut names: Vec<String> = ports.into_iter().map(|p| p.port_name).collect();
    names.sort();
    Ok(names)
}
