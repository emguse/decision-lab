import { useEffect, useRef, useState } from 'react';

function ImagePreview({
  id,
  index,
  userId,
}: {
  id: string;
  index: number;
  userId: string;
}) {
  const [url, setUrl] = useState('');
  const [bytes, setBytes] = useState(0);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    setUrl('');
    setError('');
    void fetch(`/api/images/${encodeURIComponent(id)}`, {
      headers: { 'X-Local-User': userId },
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok)
          throw new Error('Image unavailable. Upload it again.');
        const blob = await response.blob();
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setBytes(blob.size);
        setUrl(objectUrl);
      })
      .catch((e: Error) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, userId]);
  return (
    <div className="image-preview">
      {error ? (
        <p role="alert">{error}</p>
      ) : url ? (
        <>
          <a href={url} target="_blank" rel="noreferrer">
            <img src={url} alt={`Input image ${index + 1}`} />
          </a>
          <small>{(bytes / 1024).toFixed(1)} KiB</small>
        </>
      ) : (
        <p>Loading image…</p>
      )}
    </div>
  );
}
export function ImageGallery({
  ids = [],
  userId,
}: {
  ids?: string[];
  userId?: string;
}) {
  const actor = userId ?? localStorage.getItem('localUserId') ?? '';
  return (
    <div className="image-gallery">
      {ids.map((id, index) => (
        <ImagePreview
          key={`${id}-${index}`}
          id={id}
          index={index}
          userId={actor}
        />
      ))}
    </div>
  );
}
export function ImageAttachments({
  ids = [],
  userId,
  onChange,
  onBlocked,
  disabled,
}: {
  ids?: string[];
  userId: string;
  onChange: (ids: string[]) => void;
  onBlocked: (blocked: boolean) => void;
  disabled: boolean;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const locked = useRef(false);
  const currentIds = useRef(ids);
  const change = useRef(onChange);
  currentIds.current = ids;
  change.current = onChange;
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => {
    onBlocked(uploading || Boolean(error));
  }, [uploading, error, onBlocked]);
  async function upload(files: File[]) {
    if (!files.length || disabled || locked.current) return;
    if (currentIds.current.length + files.length > 4) {
      setError('Attach at most 4 images.');
      return;
    }
    locked.current = true;
    setUploading(true);
    setError('');
    let expectedIds = [...currentIds.current];
    try {
      for (const file of files) {
        if (file.size > 5 * 1024 * 1024)
          throw new Error('Images must be 5 MiB or smaller.');
        const body = new FormData();
        body.append('file', file);
        const response = await fetch('/api/images', {
          method: 'POST',
          headers: { 'X-Local-User': userId },
          body,
        });
        const result = await response.json();
        if (!response.ok)
          throw new Error(result.error || 'Image upload failed.');
        if (!active.current) return;
        if (
          currentIds.current.length !== expectedIds.length ||
          currentIds.current.some((id, index) => id !== expectedIds[index])
        )
          throw new Error(
            'Image inputs changed during upload. Add the remaining images again.',
          );
        const next = [...currentIds.current, result.id];
        expectedIds = next;
        currentIds.current = next;
        change.current(next);
      }
    } catch (e) {
      if (active.current)
        setError(e instanceof Error ? e.message : 'Image upload failed.');
    } finally {
      locked.current = false;
      if (active.current) setUploading(false);
    }
  }
  return (
    <section
      className="image-attachments"
      aria-label="Image attachments"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        void upload(Array.from(e.dataTransfer.files));
      }}
      onPaste={(e) => {
        const files = Array.from(e.clipboardData.files);
        if (files.length) {
          e.preventDefault();
          void upload(files);
        }
      }}
    >
      <label>
        Images · {ids.length}/4
        <input
          aria-label="Add images"
          type="file"
          multiple
          accept="image/png,image/jpeg,image/webp"
          disabled={disabled || uploading}
          onChange={(e) => {
            void upload(Array.from(e.target.files ?? []));
            e.target.value = '';
          }}
        />
      </label>
      <p className="hint">
        Select, drop or paste images here. Static PNG / JPEG / WebP · 5 MiB each
        · 4096 px per side. Strands requires --vision and scales images to 448
        px; direct llama.cpp requires a compatible model and --mmproj.
      </p>
      {uploading && <p role="status">Uploading images…</p>}
      {error && (
        <div role="alert">
          {error}{' '}
          <button onClick={() => setError('')}>Dismiss upload error</button>
        </div>
      )}
      <div className="image-gallery">
        {ids.map((id, index) => (
          <div key={`${id}-${index}`}>
            <ImagePreview id={id} index={index} userId={userId} />
            <div className="image-actions">
              <button
                aria-label={`Move image ${index + 1} left`}
                disabled={disabled || uploading || index === 0}
                onClick={() => {
                  const next = [...ids];
                  [next[index - 1], next[index]] = [
                    next[index],
                    next[index - 1],
                  ];
                  onChange(next);
                }}
              >
                ←
              </button>
              <button
                aria-label={`Move image ${index + 1} right`}
                disabled={disabled || uploading || index === ids.length - 1}
                onClick={() => {
                  const next = [...ids];
                  [next[index + 1], next[index]] = [
                    next[index],
                    next[index + 1],
                  ];
                  onChange(next);
                }}
              >
                →
              </button>
              <button
                aria-label={`Remove image ${index + 1}`}
                disabled={disabled || uploading}
                onClick={() => onChange(ids.filter((_, i) => i !== index))}
              >
                Remove
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
