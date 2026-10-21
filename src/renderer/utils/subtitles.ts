export interface SubtitleCue { id: number; start: number; end: number; text: string; translated?: string }

function timestamp(value: string): number {
  const match = /^(?:(\d+):)?(\d{2}):(\d{2})[.,](\d{3})$/.exec(value);
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) throw new Error('Invalid subtitle timestamp');
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

export function parseSubtitles(input: string): SubtitleCue[] {
  if (input.length > 5 * 1024 * 1024) throw new Error('Subtitle file exceeds 5 MB');
  const blocks = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n/);
  const cues: SubtitleCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) continue;
    const index = lines.findIndex(line => line.includes('-->'));
    if (index < 0) continue;
    const timing = /^(\S+)\s+-->\s+(\S+)/.exec(lines[index]);
    if (!timing) throw new Error('Invalid subtitle timing');
    const start = timestamp(timing[1]);
    const end = timestamp(timing[2]);
    const text = lines.slice(index + 1).join('\n').replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').trim();
    if (end <= start) throw new Error('Subtitle end must follow start');
    if (text) cues.push({ id: cues.length + 1, start, end, text });
    if (cues.length > 20000) throw new Error('Too many subtitle cues');
  }
  if (!cues.length) throw new Error('No valid SRT/VTT subtitles found');
  return cues.sort((a, b) => a.start - b.start).map((cue, index) => ({ ...cue, id: index + 1 }));
}

export function activeSubtitles(cues: SubtitleCue[], time: number): SubtitleCue[] {
  return cues.filter(cue => cue.start <= time && time < cue.end);
}

export function subtitleBatches(cues: SubtitleCue[]): SubtitleCue[][] {
  const batches: SubtitleCue[][] = [];
  let batch: SubtitleCue[] = [];
  let length = 0;
  for (const cue of cues) {
    if (cue.text.length > 20000) throw new Error('A subtitle cue exceeds the translation limit');
    if (batch.length && (batch.length >= 15 || length + cue.text.length > 8000)) {
      batches.push(batch); batch = []; length = 0;
    }
    batch.push(cue); length += cue.text.length;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

function srtTime(time: number): string {
  const ms = Math.round(time * 1000);
  return `${String(Math.floor(ms / 3600000)).padStart(2, '0')}:${String(Math.floor(ms / 60000) % 60).padStart(2, '0')}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')},${String(ms % 1000).padStart(3, '0')}`;
}

export function exportSubtitles(cues: SubtitleCue[], mode: 'bilingual' | 'original' | 'translated'): string {
  return cues.map((cue, index) => `${index + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${mode === 'original' ? cue.text : mode === 'translated' ? cue.translated || cue.text : [cue.translated, cue.text].filter(Boolean).join('\n')}\n`).join('\n');
}
