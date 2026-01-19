
/**
 * Deterministic JSON stringify to ensure consistent prompt caching.
 * Sorts object keys recursively before stringification.
 */
export function stableStringify(obj: any, space?: string | number): string {
    const sortKeys = (o: any): any => {
        if (Array.isArray(o)) {
            return o.map(sortKeys);
        } else if (o !== null && typeof o === 'object') {
            return Object.keys(o).sort().reduce((result, key) => {
                result[key] = sortKeys(o[key]);
                return result;
            }, {} as any);
        }
        return o;
    };

    return JSON.stringify(sortKeys(obj), null, space);
}
