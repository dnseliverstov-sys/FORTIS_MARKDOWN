/** Preserve the source bytes when Gravity only changes their representation. */
export class DocumentSync {
  source: string;
  private rendered = '';
  private sourceByRendering = new Map<string, string>();

  constructor(source: string) { this.source = source; }

  reset(source: string, rendered: string, mode: string): void {
    this.source = source;
    this.rendered = rendered;
    this.sourceByRendering.set(`${mode}:${rendered}`, source);
  }

  change(rendered: string, mode: string): string | null {
    if (rendered === this.rendered) return null;
    this.rendered = rendered;
    const source = this.sourceByRendering.get(`${mode}:${rendered}`) ?? rendered;
    if (source === this.source) return null;
    this.source = source;
    return source;
  }
}
