# Voice room

The page of a voice room: Opus from the browser over WebTransport to our relays, and the client
in Rust compiled to WebAssembly (`voice.wasm`), which picks the relay and buffers each speaker's
frames.

Open it with a link that carries the relay, its certificate hash and your token after the `#`:
the browser never sends that part to any server. Use Chrome or Edge.
