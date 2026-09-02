// Type definitions for @bramburn/clipboard-rs.
//
// Mirrors the four-method contract of @mariozechner/clipboard so the
// loader at packages/coding-agent/src/utils/clipboard-native.ts can
// `require("@bramburn/clipboard-rs")` without code changes beyond the
// import path.

export declare function getText(): Promise<string | null>;
export declare function setText(text: string): Promise<void>;
export declare function hasImage(): boolean;
export declare function getImageBinary(): Promise<number[]>;
export declare function addonMarker(): string;
