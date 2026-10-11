import { useEffect, useMemo, useState } from 'react';
import MarkdownIt from 'markdown-it';
import guide from '../docs/user-guide.md?raw';
import exchange from '../docs/experiment-exchange.md?raw';
import connections from '../docs/connections.md?raw';
import operations from '../docs/operations.md?raw';
import license from '../LICENSE?raw';
import notices from '../THIRD_PARTY_NOTICES.md?raw';

export const helpDocuments = [
  {
    id: 'guide',
    title: 'User guide',
    file: 'user-guide.md',
    path: 'docs/user-guide.md',
    text: guide,
  },
  {
    id: 'exchange',
    title: 'Exchange specification v1',
    file: 'experiment-exchange.md',
    path: 'docs/experiment-exchange.md',
    text: exchange,
  },
  {
    id: 'connections',
    title: 'Connection settings',
    file: 'connections.md',
    path: 'docs/connections.md',
    text: connections,
  },
  {
    id: 'operations',
    title: 'Operations and development',
    file: 'operations.md',
    path: 'docs/operations.md',
    text: operations,
  },
  {
    id: 'license',
    title: 'MIT License',
    file: 'LICENSE',
    path: 'LICENSE',
    text: license,
  },
  {
    id: 'notices',
    title: 'Third-party notices',
    file: 'THIRD_PARTY_NOTICES.md',
    path: 'THIRD_PARTY_NOTICES.md',
    text: notices,
  },
] as const;
export type HelpTopic = (typeof helpDocuments)[number]['id'];
const resources = import.meta.glob<string>(
  [
    '../docs/*.md',
    '../examples/exchange/*.{yaml,json}',
    '../LICENSE',
    '../THIRD_PARTY_NOTICES.md',
    '../third-party-licenses/*.txt',
    '../systemone.example.toml',
  ],
  { eager: true, query: '?raw', import: 'default' },
);
const markdown = new MarkdownIt({ html: false, linkify: false });
markdown.renderer.rules.heading_open = (tokens, index, options, env, self) => {
  const text = tokens[index + 1]?.content ?? '';
  const base = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');
  const counts =
    (env?.headings as Map<string, number> | undefined) ??
    new Map<string, number>();
  if (env) env.headings = counts;
  const count = counts.get(base) ?? 0;
  counts.set(base, count + 1);
  tokens[index].attrSet('id', count ? `${base}-${count}` : base);
  return self.renderToken(tokens, index, options);
};
export function saveHelpFile(text: string, filename: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: 'text/plain;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function Help({
  topic,
  onTopic,
  onBack,
}: {
  topic: HelpTopic;
  onTopic: (topic: HelpTopic) => void;
  onBack: () => void;
}) {
  const doc = helpDocuments.find((d) => d.id === topic)!;
  const [supplement, setSupplement] = useState<{
    path: string;
    text: string;
  } | null>(null);
  const text = supplement?.text ?? doc.text;
  const path = supplement?.path ?? doc.path;
  const html = useMemo(() => markdown.render(text, {}), [text]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [path]);
  const [notice, setNotice] = useState('');
  return (
    <section className="help-workspace">
      <header>
        <div>
          <div className="eyebrow">DECISION LAB / HELP</div>
          <h1>Help</h1>
          <p>
            Read the instructions and specification, then return to your work.
          </p>
        </div>
        <button onClick={onBack}>Back to work</button>
      </header>
      <div className="help-layout">
        <nav className="panel help-navigation" aria-label="Documentation">
          {helpDocuments.map((d) => (
            <button
              key={d.id}
              aria-pressed={d.id === topic}
              onClick={() => {
                setNotice('');
                setSupplement(null);
                onTopic(d.id);
              }}
            >
              {d.title}
            </button>
          ))}
          <p className="hint">
            This app bundles the same Markdown documents as the repository.
          </p>
          <button onClick={() => saveHelpFile(text, path.split('/').pop()!)}>
            Save Markdown
          </button>
        </nav>
        <div>
          {notice && (
            <p role="status" className="setup">
              {notice}
            </p>
          )}
          <article
            className="panel help-document"
            onClick={(event) => {
              const anchor = (event.target as Element).closest('a');
              if (!anchor) return;
              const href = anchor.getAttribute('href') ?? '';
              if (/^https?:\/\//i.test(href)) {
                anchor.target = '_blank';
                anchor.rel = 'noopener noreferrer';
                return;
              }
              if (href.startsWith('#')) return;
              event.preventDefault();
              const targetUrl = new URL(
                href,
                `https://repository.local/${path}`,
              );
              const targetPath = targetUrl.pathname.slice(1);
              const target = helpDocuments.find((d) => targetPath === d.path);
              if (target) {
                setNotice('');
                setSupplement(null);
                onTopic(target.id);
                return;
              }
              const resource = resources[`../${targetPath}`];
              if (resource !== undefined) {
                setNotice('');
                if (
                  targetPath.endsWith('.md') ||
                  targetPath.endsWith('.txt') ||
                  targetPath === 'LICENSE'
                )
                  setSupplement({ path: targetPath, text: resource });
                else saveHelpFile(resource, targetPath.split('/').pop()!);
                return;
              }
              setNotice(
                `This link refers to a repository resource:${href}. See Operations and development for its location.`,
              );
            }}
            dangerouslySetInnerHTML={{ __html: html }}
          />
        </div>
      </div>
    </section>
  );
}
