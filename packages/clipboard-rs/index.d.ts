// Type definitions for @bramburn/clipboard-rs.
//
// Mirrors the four-method contract of @mariozechner/clipboard so the
// loader at packages/coding-agent/src/utils/clipboard-native.ts can
// import the same shape. The actual .node load is lazy (only happens
// on the first function call), so importing this module on a
// platform without a prebuild never throws.

export declare function getText(): Promise<string | null>;
export declare function setText(text: string): Promise<void>;
export declare function hasImage(): boolean;
export declare function getImageBinary(): Promise<number[]>;
export declare function addonMarker(): string;
