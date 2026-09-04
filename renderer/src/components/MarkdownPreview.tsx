import {useEffect, useState} from 'react';
import {Loader} from '@gravity-ui/uikit';
import {renderMarkdownWithDiagrams} from '../markdown/pipeline';

interface Props {
  markdown: string;
  jiraBase: string;
  theme: 'light' | 'dark';
  className?: string;
  onRendered?(): void;
}

export function MarkdownPreview({markdown, jiraBase, theme, className = '', onRendered}: Props) {
  const [html, setHtml] = useState('');
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    if (!loading && html) onRendered?.();
  }, [html, loading, onRendered]);

  useEffect(() => {
    let canceled = false;
    setLoading(true);
    const timer = window.setTimeout(() => {
      void renderMarkdownWithDiagrams(markdown, jiraBase, theme).then((result) => {
        if (!canceled) setHtml(result.html);
      }).finally(() => {
        if (!canceled) setLoading(false);
      });
    }, 80);
    return () => { canceled = true; window.clearTimeout(timer); };
  }, [markdown, jiraBase, theme]);

  return (
    <div className={`fortis-preview ${className}`}>
      {loading && !html ? <div className="preview-loader"><Loader size="m" /></div> : null}
      <article className="fortis-document" dangerouslySetInnerHTML={{__html: html}} />
    </div>
  );
}
