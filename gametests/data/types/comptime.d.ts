declare module "comptime" {
    /**
     * Evaluates the given function in Node.js while the pack is being built and
     * replaces the call with the serialized result, so no comptime code ends up
     * in the compiled script.
     *
     * The callback may be async and may only use imports and top-level
     * declarations of its module. Declarations and imports that are only used by
     * comptime callbacks are removed from the compiled output.
     *
     * The result must be serializable: primitives, plain objects, arrays, Date,
     * RegExp, Map and Set are supported.
     */
    export function comptime<T>(fn: () => T | Promise<T>): T;
}
