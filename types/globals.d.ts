// Re-binds the global `Request`, `Response`, `Headers`, and `WebSocket`
// constructors so the `tsgo --noEmit` check sees the full undici-types shape.
//
// Why this file exists
// --------------------
// `@types/node` v22 declares these globals in `web-globals/fetch.d.ts` via:
//
//     type _Request = typeof globalThis extends { onmessage: any } ? {} : undici.Request;
//     interface Request extends _Request {}
//     var Request: typeof globalThis extends { onmessage: any; Request: infer T } ? T : typeof undici.Request;
//
// `tsgo` (TypeScript 7.0.0-dev native compiler) evaluates the conditional
// `typeof globalThis extends { onmessage: any }` as `true`, which collapses
// the interface members to `{}` and leaves the `var` binding as the empty
// `{}` shape, breaking `instanceof Request` narrowing and property access on
// instances. tsc 5.9.3 evaluates the same conditional as `false`, so it inherits
// the full `undici.*` shape and these errors only fail under tsgo.
//
// Re-declaring the `var` bindings here with the actual `undici-types` class
// constructors restores the constructor types so that `instanceof` produces
// instances with the full undici-types shape (url, method, headers, etc.),
// without having to redeclare every interface member (which would also need
// to stay binary-compatible with undici-types for `tsc` to keep accepting the
// augmentation).
import { Headers as UndiciHeaders, Request as UndiciRequest, Response as UndiciResponse, WebSocket as UndiciWebSocket } from "undici-types";

declare global {
	var Headers: typeof UndiciHeaders;
	var Request: typeof UndiciRequest;
	var Response: typeof UndiciResponse;
	var WebSocket: typeof UndiciWebSocket;
}

export {};