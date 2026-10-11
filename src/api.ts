export async function api<T>(
  path: string,
  body?: unknown,
  method = 'POST',
  userId = localStorage.getItem('localUserId') ?? '',
): Promise<T> {
  const res = await fetch(
    `/api/${path}`,
    body
      ? {
          method,
          headers: {
            'Content-Type': 'application/json',
            'X-Local-User': userId,
          },
          body: JSON.stringify(body),
        }
      : { headers: { 'X-Local-User': userId } },
  );
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'The operation failed.');
  return data;
}
