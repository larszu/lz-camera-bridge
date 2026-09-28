import { BridgeServer } from './BridgeServer.js';

const PORT = Number(process.env.BRIDGE_PORT ?? 9700);

// Persistence is ON for the real bridge and OFF for the tests: the site lives
// in `LZ_BRIDGE_CONFIG_DIR/site.json` (default ~/.lz-camera-bridge).
const server = new BridgeServer(PORT, undefined, { persist: true, allowAnyStreamHost: process.env.LZ_BRIDGE_ANY_STREAM_HOST === '1' });
server.start();

process.on('SIGINT', () => {
  console.log('\n[Bridge] Shutting down...');
  server.stop();
  process.exit(0);
});

process.on('SIGTERM', () => {
  server.stop();
  process.exit(0);
});
