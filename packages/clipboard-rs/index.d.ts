// Type definitions for @bramburn/clipboard-rs.
//
// Mirrors the four-method contract of @mariozechner/clipboard so the
// loader at packages/coding-agent/src/utils/clipboard-native.ts can
// import the same shape. The actual .node load is lazy (only happens
// on the first function call), so importing this module on a
// platform without a prebuild never throws.
//
// getImageBinary returns a napi `Buffer` (a Uint8Array subclass). The
// upstream addon returned `Array<number>` instead; the TS-side caller
// accepts both shapes so older prebuilds keep working.

export declare function getText(): Promise<string | null>;
export declare function setText(text: string): Promise<void>;
export declare function hasImage(): Promise<boolean>;
export declare function getImageBinary(): Promise<Buffer>;
export declare function addonMarker(): string;