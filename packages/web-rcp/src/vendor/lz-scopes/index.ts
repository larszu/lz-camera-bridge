// Library entry for hosts that embed LZ Scopes (lz-camera-bridge, cable-planner).
// Vendored copy: the PATTERNS/RESOLUTIONS export is dropped (see VENDOR.md).
export { ScopeView, type ScopeViewOptions } from './embed';
export { Source, type SourceSettings, type StreamInfo } from './sources';
export { SCOPE_LABELS, type ScopeType, type Unit } from './graticule';
export * as color from './color';
