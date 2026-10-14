import WebSocket from 'ws'

/**
 * The bridge's control socket (default port 9700) — the one the panel uses.
 *
 * The Companion API (HTTP 9702 / WebSocket 9701) carries camera commands,
 * paint state and the global tally, but not the studio side: the camera
 * list, studio shots, the mixer tally per camera, held recalls, moves and
 * head jobs only exist on this socket, and recalls answer on it ("held",
 * "recalled", errors). So the module holds both connections.
 */
export class ControlLink {
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false

  onOpen?: () => void
  onClose?: () => void
  onMessage?: (msg: Record<string, unknown>) => void
  onError?: (message: string) => void

  constructor(
    private url: string,
    private readonly reconnectMs = 2000,
  ) {}

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  connect(): void {
    this.destroyed = false
    this.openSocket()
  }

  destroy(): void {
    this.destroyed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = null
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.on('error', () => {})
      this.ws.close()
      this.ws = null
    }
  }

  /** Sends one client message. False (and nothing sent) while the socket is not open. */
  send(type: string, payload: Record<string, unknown> = {}): boolean {
    if (!this.open) return false
    this.ws!.send(JSON.stringify({ ...payload, type }))
    return true
  }

  private openSocket(): void {
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.on('error', () => {})
      this.ws.close()
    }
    const ws = new WebSocket(this.url)
    this.ws = ws
    ws.on('open', () => this.onOpen?.())
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString()) as unknown
        if (msg && typeof msg === 'object') this.onMessage?.(msg as Record<string, unknown>)
      } catch (error) {
        this.onError?.((error as Error).message)
      }
    })
    ws.on('error', (error) => this.onError?.(error.message))
    ws.on('close', () => {
      if (this.ws !== ws) return
      this.onClose?.()
      if (!this.destroyed) this.reconnectTimer = setTimeout(() => this.openSocket(), this.reconnectMs)
    })
  }
}
