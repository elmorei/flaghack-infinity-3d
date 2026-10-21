/** Exact source revision shared by the static client and its separately installed host. */
declare const __FLAGHACK_BUILD_ID__: string;
export const BUILD_ID = typeof __FLAGHACK_BUILD_ID__ === 'string' ? __FLAGHACK_BUILD_ID__ : 'development';
