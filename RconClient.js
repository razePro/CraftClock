import { NativeModules } from 'react-native';

function makePacket(Buffer, id, type, payload) {
  const text = Buffer.from(payload, 'utf8');
  const packet = Buffer.alloc(14 + text.length);
  packet.writeInt32LE(10 + text.length, 0);
  packet.writeInt32LE(id, 4);
  packet.writeInt32LE(type, 8);
  text.copy(packet, 12);
  packet[12 + text.length] = 0;
  packet[13 + text.length] = 0;
  return packet;
}

function readInt32LE(bytes, offset) {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) | 0;
}

export function executeRconCommand({ host, port, password, command }) {
  return new Promise((resolve, reject) => {
    if (!NativeModules?.TcpSockets) {
      reject(new Error('RCON requires the installed iOS app. Expo Go does not include the TCP module.'));
      return;
    }

    let TcpSocket;
    let Buffer;
    try {
      const tcpModule = require('react-native-tcp-socket');
      TcpSocket = tcpModule.default || tcpModule;
      Buffer = require('buffer').Buffer;
    } catch {
      reject(new Error('The RCON TCP module is unavailable. Install the latest app build.'));
      return;
    }
    if (typeof TcpSocket?.createConnection !== 'function') {
      reject(new Error('The RCON TCP module did not load correctly. Rebuild and reinstall the app.'));
      return;
    }

    let socket;
    let buffer = Buffer.alloc(0);
    let phase = 'auth';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      try { socket?.destroy(); } catch { /* The socket may already be closed. */ }
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => finish(new Error('RCON timed out. Check that RCON is enabled and the port is reachable.')), 10000);

    try {
      socket = TcpSocket.createConnection({ host, port, connectTimeout: 7000 }, () => {
        socket.write(makePacket(Buffer, 1, 3, password));
      });
      socket.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
        while (buffer.length >= 4) {
          const length = readInt32LE(buffer, 0);
          if (length < 10 || length > 1024 * 1024) {
            finish(new Error('The server returned an invalid RCON response.'));
            return;
          }
          if (buffer.length < length + 4) return;

          const packet = buffer.subarray(0, length + 4);
          buffer = Buffer.from(buffer.subarray(length + 4));
          const id = readInt32LE(packet, 4);
          const type = readInt32LE(packet, 8);
          const payload = Buffer.from(packet.subarray(12, length + 2)).toString('utf8');

          if (phase === 'auth') {
            if (id === -1) {
              finish(new Error('RCON rejected the password. Check the saved password.'));
              return;
            }
            if (id === 1 && type === 2) {
              phase = 'command';
              socket.write(makePacket(Buffer, 2, 2, command));
            }
          } else if (phase === 'command' && id === 2 && type === 0) {
            finish(null, payload.replace(/\u00a7[0-9a-fk-or]/gi, '').trim());
            return;
          }
        }
      });
      socket.on('error', (error) => finish(new Error(error?.message || 'Could not connect to the RCON server.')));
      socket.on('close', () => {
        if (!settled) finish(new Error('The server closed the RCON connection before replying.'));
      });
    } catch (error) {
      finish(new Error(error?.message || 'Could not open the RCON connection.'));
    }
  });
}

export async function queryMinecraftGametime(connection) {
  const response = await executeRconCommand({ ...connection, command: 'time query gametime' });
  const match = response.match(/(-?\d+)\D*$/);
  if (!match) throw new Error(`RCON replied, but no game tick value was found: ${response || '(empty response)'}`);
  const ticks = Number(match[1]);
  if (!Number.isSafeInteger(ticks) || ticks < 0) throw new Error('The server returned an invalid tick value.');
  return ticks;
}

export async function queryMinecraftDaytime(connection) {
  const response = await executeRconCommand({ ...connection, command: '/time query day' });
  const match = response.match(/Timeline\s+minecraft:day\s+is\s+at\s+(\d+)\s+tick\(s\)/i);
  if (!match) {
    throw new Error(`RCON replied, but the custom day timeline value was not found: ${response || '(empty response)'}`);
  }
  const ticks = Number(match[1]);
  if (!Number.isSafeInteger(ticks) || ticks < 0 || ticks >= 24000) {
    throw new Error('The server returned an invalid daytime tick value.');
  }
  return ticks;
}
