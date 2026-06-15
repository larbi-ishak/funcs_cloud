/**
 * SWR fetcher with error handling.
 * Centralizes API fetching for the entire dashboard.
 */
export async function fetcher<T = unknown>(url: string): Promise<T> {
    const res = await fetch(url);
    if (!res.ok) {
        const error = new Error(`API error: ${res.status} ${res.statusText}`);
        throw error;
    }
    return res.json();
}