## LZ Camera Bridge

Native Bitfocus Companion module for the local camera bridge.

### Configuration

Set the bridge host and ports to match the running bridge server.

Default values:
- HTTP: 9702
- WebSocket: 9701

### What this module does

- Sends camera actions to the bridge
- Reads live camera state
- Reads tally state
- Exposes Companion variables and feedbacks

### Bridge requirement

The bridge server must be running before this Companion module can connect.
