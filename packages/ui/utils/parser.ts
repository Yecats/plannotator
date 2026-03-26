import { Block, type Annotation, type EditorAnnotation, type ImageAttachment } from '../types';
import { planDenyFeedback } from '@plannotator/shared/feedback-templates';
import type { PlanDiffBlock, PlanDiffStats } from './planDiffEngine';

/**
 * Parsed YAML frontmatter as key-value pairs.
 */
export interface Frontmatter {
  [key: string]: string | string[];
}

/**
 * Extract YAML frontmatter from markdown if present.
 * Returns both the parsed frontmatter and the remaining markdown.
 */
export function extractFrontmatter(markdown: string): { frontmatter: Frontmatter | null; content: string } {
  const trimmed = markdown.trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: null, content: markdown };
  }

  // Find the closing ---
  const endIndex = trimmed.indexOf('\n---', 3);
  if (endIndex === -1) {
    return { frontmatter: null, content: markdown };
  }

  // Extract frontmatter content (between the --- delimiters)
  const frontmatterRaw = trimmed.slice(4, endIndex).trim();
  const afterFrontmatter = trimmed.slice(endIndex + 4).trimStart();

  // Parse simple YAML (key: value pairs)
  const frontmatter: Frontmatter = {};
  let currentKey: string | null = null;
  let currentArray: string[] | null = null;

  for (const line of frontmatterRaw.split('\n')) {
    const trimmedLine = line.trim();

    // Array item (- value)
    if (trimmedLine.startsWith('- ') && currentKey) {
      const value = trimmedLine.slice(2).trim();
      if (!currentArray) {
        currentArray = [];
        frontmatter[currentKey] = currentArray;
      }
      currentArray.push(value);
      continue;
    }

    // Key: value pair
    const colonIndex = trimmedLine.indexOf(':');
    if (colonIndex > 0) {
      currentKey = trimmedLine.slice(0, colonIndex).trim();
      const value = trimmedLine.slice(colonIndex + 1).trim();
      currentArray = null;

      if (value) {
        frontmatter[currentKey] = value;
      }
    }
  }

  return { frontmatter, content: afterFrontmatter };
}

/**
 * A simplified markdown parser that splits content into linear blocks.
 * For a production app, we would use a robust AST walker (remark),
 * but for this demo, we want predictable text-anchoring.
 */
export const parseMarkdownToBlocks = (markdown: string): Block[] => {
  const { content: cleanMarkdown } = extractFrontmatter(markdown);
  const lines = cleanMarkdown.split('\n');
  const blocks: Block[] = [];
  let currentId = 0;

  let buffer: string[] = [];
  let currentType: Block['type'] = 'paragraph';
  let currentLevel = 0;
  let bufferStartLine = 1; // Track the start line of the current buffer

  const flush = () => {
    if (buffer.length > 0) {
      const content = buffer.join('\n');
      blocks.push({
        id: `block-${currentId++}`,
        type: currentType,
        content: content,
        level: currentLevel,
        order: currentId,
        startLine: bufferStartLine
      });
      buffer = [];
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const currentLineNum = i + 1; // 1-based index

    // Headings
    if (trimmed.startsWith('#')) {
      flush();
      const level = trimmed.match(/^#+/)?.[0].length || 1;
      blocks.push({
        id: `block-${currentId++}`,
        type: 'heading',
        content: trimmed.replace(/^#+\s*/, ''),
        level,
        order: currentId,
        startLine: currentLineNum
      });
      continue;
    }

    // Horizontal Rule
    if (trimmed === '---' || trimmed === '***') {
      flush();
      blocks.push({
        id: `block-${currentId++}`,
        type: 'hr',
        content: '',
        order: currentId,
        startLine: currentLineNum
      });
      continue;
    }

    // List Items (Simple detection)
    if (trimmed.match(/^(\*|-|\d+\.)\s/)) {
      flush(); // Treat each list item as a separate block for easier annotation
      // Calculate indentation level from leading whitespace
      const leadingWhitespace = line.match(/^(\s*)/)?.[1] || '';
      // Count spaces (2 spaces = 1 level) or tabs (1 tab = 1 level)
      const spaceCount = leadingWhitespace.replace(/\t/g, '  ').length;
      const listLevel = Math.floor(spaceCount / 2);

      // Remove list marker
      let content = trimmed.replace(/^(\*|-|\d+\.)\s/, '');

      // Check for checkbox syntax: [ ] or [x] or [X]
      let checked: boolean | undefined = undefined;
      const checkboxMatch = content.match(/^\[([ xX])\]\s*/);
      if (checkboxMatch) {
        checked = checkboxMatch[1].toLowerCase() === 'x';
        content = content.replace(/^\[([ xX])\]\s*/, '');
      }

      blocks.push({
        id: `block-${currentId++}`,
        type: 'list-item',
        content,
        level: listLevel,
        checked,
        order: currentId,
        startLine: currentLineNum
      });
      continue;
    }

    // Blockquotes
    if (trimmed.startsWith('>')) {
       // Check if previous was blockquote, if so, merge? No, separate for now
       flush();
       blocks.push({
         id: `block-${currentId++}`,
         type: 'blockquote',
         content: trimmed.replace(/^>\s*/, ''),
         order: currentId,
         startLine: currentLineNum
       });
       continue;
    }
    
    // Code blocks (naive)
    if (trimmed.startsWith('```')) {
      flush();
      const codeStartLine = currentLineNum;
      // Count backticks in opening fence to support nested fences (e.g. ```` wrapping ```)
      const fenceLen = trimmed.match(/^`+/)?.[0].length ?? 3;
      const closingFence = new RegExp('^`{' + fenceLen + ',}\\s*$');
      // Extract language from fence (e.g., ```rust → "rust")
      const language = trimmed.slice(fenceLen).trim() || undefined;
      // Fast forward until end of code block
      let codeContent = [];
      i++; // Skip start fence
      while(i < lines.length && !closingFence.test(lines[i])) {
        codeContent.push(lines[i]);
        i++;
      }
      blocks.push({
        id: `block-${currentId++}`,
        type: 'code',
        content: codeContent.join('\n'),
        language,
        order: currentId,
        startLine: codeStartLine
      });
      continue;
    }

    // Tables (lines starting and containing |)
    if (trimmed.startsWith('|') || (trimmed.includes('|') && trimmed.match(/^\|?.+\|.+\|?$/))) {
      flush();
      const tableStartLine = currentLineNum;
      const tableLines: string[] = [line];

      // Collect all consecutive table lines
      while (i + 1 < lines.length) {
        const nextLine = lines[i + 1].trim();
        // Continue if line has table structure (contains | and looks like table content)
        if (nextLine.startsWith('|') || (nextLine.includes('|') && nextLine.match(/^\|?.+\|.+\|?$/))) {
          i++;
          tableLines.push(lines[i]);
        } else {
          break;
        }
      }

      blocks.push({
        id: `block-${currentId++}`,
        type: 'table',
        content: tableLines.join('\n'),
        order: currentId,
        startLine: tableStartLine
      });
      continue;
    }

    // Empty lines separate paragraphs
    if (trimmed === '') {
      flush();
      currentType = 'paragraph';
      continue;
    }

    // Accumulate paragraph text
    if (buffer.length === 0) {
      bufferStartLine = currentLineNum;
    }
    buffer.push(line);
  }
  
  flush(); // Final flush

  return blocks;
};

/** Wrap feedback output with the deny preamble for pasting into agent sessions */
export const wrapFeedbackForAgent = (feedback: string): string =>
  planDenyFeedback(feedback);

/**
 * Convert a single Block back to its markdown source representation.
 */
export function blockToMarkdown(block: Block): string {
  switch (block.type) {
    case 'heading':
      return '#'.repeat(block.level ?? 1) + ' ' + block.content;
    case 'list-item': {
      const indent = '  '.repeat(block.level ?? 0);
      const marker = '- ';
      if (block.checked === true) return `${indent}${marker}[x] ${block.content}`;
      if (block.checked === false) return `${indent}${marker}[ ] ${block.content}`;
      return `${indent}${marker}${block.content}`;
    }
    case 'blockquote':
      return '> ' + block.content;
    case 'code':
      return '```' + (block.language ?? '') + '\n' + block.content + '\n```';
    case 'table':
      return block.content;
    case 'hr':
      return '---';
    case 'paragraph':
    default:
      return block.content;
  }
}

/**
 * Convert an array of Blocks back to a markdown string.
 * Uses startLine gaps from the original markdown to preserve spacing.
 */
export function blocksToMarkdown(blocks: Block[], originalMarkdown?: string): string {
  if (blocks.length === 0) return '';

  const result: string[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const md = blockToMarkdown(block);

    if (i > 0) {
      const prevBlock = blocks[i - 1];
      const prevEndLine = estimateBlockEndLine(prevBlock);
      const gap = block.startLine - prevEndLine - 1;
      // Insert blank lines to match original spacing (at least one between blocks)
      const blankLines = Math.max(gap, 1);
      for (let j = 0; j < blankLines; j++) result.push('');
    }

    result.push(md);
  }

  return result.join('\n');
}

/**
 * Estimate the last line a block occupies based on its content.
 */
function estimateBlockEndLine(block: Block): number {
  if (block.type === 'code') {
    // Opening fence + content lines + closing fence
    const contentLines = block.content.split('\n').length;
    return block.startLine + contentLines + 1;
  }
  const contentLines = block.content.split('\n').length;
  return block.startLine + contentLines - 1;
}

/**
 * Replace a single block's content in the full markdown string.
 * Uses startLine to locate the block and replaces its line range.
 */
export function replaceBlockInMarkdown(
  fullMarkdown: string,
  block: Block,
  newMarkdown: string,
  allBlocks: Block[]
): string {
  const lines = fullMarkdown.split('\n');
  const startIdx = block.startLine - 1; // 0-based

  // Find the end of this block: either the next block's startLine - 1 or end of file
  const blockIndex = allBlocks.findIndex(b => b.id === block.id);
  let endIdx: number;
  if (blockIndex < allBlocks.length - 1) {
    const nextBlock = allBlocks[blockIndex + 1];
    // Walk back from next block's start to skip blank lines between blocks
    endIdx = nextBlock.startLine - 2; // 0-based, exclusive of spacing
    while (endIdx > startIdx && lines[endIdx]?.trim() === '') {
      endIdx--;
    }
    endIdx++; // make exclusive
  } else {
    // Last block: go to end of file, but trim trailing blank lines
    endIdx = lines.length;
    while (endIdx > startIdx + 1 && lines[endIdx - 1]?.trim() === '') {
      endIdx--;
    }
  }

  const newLines = newMarkdown.split('\n');
  const result = [
    ...lines.slice(0, startIdx),
    ...newLines,
    ...lines.slice(endIdx),
  ];
  return result.join('\n');
}

/**
 * Apply multiple block edits to the full markdown.
 * Edits are applied from bottom-to-top to avoid startLine drift.
 */
export function applyBlockEdits(
  fullMarkdown: string,
  blocks: Block[],
  blockEdits: Map<string, string>
): string {
  // Sort edited blocks by startLine descending to avoid drift
  const editedBlocks = blocks
    .filter(b => blockEdits.has(b.id))
    .sort((a, b) => b.startLine - a.startLine);

  let result = fullMarkdown;
  for (const block of editedBlocks) {
    const newContent = blockEdits.get(block.id)!;
    result = replaceBlockInMarkdown(result, block, newContent, blocks);
  }
  return result;
}

/**
 * Format plan diff blocks into a compact markdown summary for AI feedback.
 * Only includes changed sections (added/removed/modified), skipping unchanged content.
 */
export function formatEditDiffSummary(
  blocks: PlanDiffBlock[],
  stats: PlanDiffStats,
): string {
  const changedBlocks = blocks.filter(b => b.type !== 'unchanged');
  if (changedBlocks.length === 0) return '';

  let output = `## Plan Edits Summary\n\n`;
  output += `**${stats.modifications} modification${stats.modifications !== 1 ? 's' : ''}, `;
  output += `${stats.additions} line${stats.additions !== 1 ? 's' : ''} added, `;
  output += `${stats.deletions} line${stats.deletions !== 1 ? 's' : ''} removed**\n\n`;

  for (const block of changedBlocks) {
    switch (block.type) {
      case 'modified':
        output += `### Changed:\n`;
        output += `\`\`\`diff\n`;
        for (const line of (block.oldContent ?? '').split('\n').filter(Boolean)) {
          output += `- ${line}\n`;
        }
        for (const line of block.content.split('\n').filter(Boolean)) {
          output += `+ ${line}\n`;
        }
        output += `\`\`\`\n\n`;
        break;
      case 'added':
        output += `### Added:\n`;
        output += `\`\`\`diff\n`;
        for (const line of block.content.split('\n').filter(Boolean)) {
          output += `+ ${line}\n`;
        }
        output += `\`\`\`\n\n`;
        break;
      case 'removed':
        output += `### Removed:\n`;
        output += `\`\`\`diff\n`;
        for (const line of block.content.split('\n').filter(Boolean)) {
          output += `- ${line}\n`;
        }
        output += `\`\`\`\n\n`;
        break;
    }
  }

  return output;
}

export const exportAnnotations = (blocks: Block[], annotations: any[], globalAttachments: ImageAttachment[] = [], title: string = 'Plan Feedback', subject: string = 'plan'): string => {
  if (annotations.length === 0 && globalAttachments.length === 0) {
    return 'No changes detected.';
  }

  // Sort annotations by block and offset
  const sortedAnns = [...annotations].sort((a, b) => {
    const blockA = blocks.findIndex(blk => blk.id === a.blockId);
    const blockB = blocks.findIndex(blk => blk.id === b.blockId);
    if (blockA !== blockB) return blockA - blockB;
    return a.startOffset - b.startOffset;
  });

  let output = `# ${title}\n\n`;

  // Add global reference images section if any
  if (globalAttachments.length > 0) {
    output += `## Reference Images\n`;
    output += `Please review these reference images (use the Read tool to view):\n`;
    globalAttachments.forEach((img, idx) => {
      output += `${idx + 1}. [${img.name}] \`${img.path}\`\n`;
    });
    output += `\n`;
  }

  if (annotations.length > 0) {
    output += `I've reviewed this ${subject} and have ${annotations.length} piece${annotations.length > 1 ? 's' : ''} of feedback:\n\n`;
  }

  sortedAnns.forEach((ann, index) => {
    const block = blocks.find(b => b.id === ann.blockId);

    output += `## ${index + 1}. `;

    // Add diff context label if annotation was created in diff view
    if (ann.diffContext) {
      output += `[In diff content] `;
    }

    switch (ann.type) {
      case 'DELETION':
        output += `Remove this\n`;
        output += `\`\`\`\n${ann.originalText}\n\`\`\`\n`;
        output += `> I don't want this in the ${subject}.\n`;
        break;

      case 'INSERTION':
        output += `Add this\n`;
        output += `\`\`\`\n${ann.text}\n\`\`\`\n`;
        break;

      case 'REPLACEMENT':
        output += `Change this\n`;
        output += `**From:**\n\`\`\`\n${ann.originalText}\n\`\`\`\n`;
        output += `**To:**\n\`\`\`\n${ann.text}\n\`\`\`\n`;
        break;

      case 'COMMENT':
        if (ann.isQuickLabel) {
          output += `[${ann.text}] Feedback on: "${ann.originalText}"\n`;
          if (ann.quickLabelTip) {
            output += `> ${ann.quickLabelTip}\n`;
          }
        } else {
          output += `Feedback on: "${ann.originalText}"\n`;
          output += `> ${ann.text}\n`;
        }
        break;

      case 'GLOBAL_COMMENT':
        output += `General feedback about the ${subject}\n`;
        output += `> ${ann.text}\n`;
        break;
    }

    // Add attached images for this annotation
    if (ann.images && ann.images.length > 0) {
      output += `**Attached images:**\n`;
      ann.images.forEach((img: ImageAttachment) => {
        output += `- [${img.name}] \`${img.path}\`\n`;
      });
    }

    output += '\n';
  });

  output += `---\n`;

  // Quick Label Summary
  const labeledAnns = sortedAnns.filter((a: any) => a.isQuickLabel && a.text);
  if (labeledAnns.length > 0) {
    const grouped = new Map<string, number>();
    labeledAnns.forEach((a: any) => {
      grouped.set(a.text, (grouped.get(a.text) || 0) + 1);
    });

    output += `\n## Label Summary\n\n`;
    for (const [text, count] of grouped) {
      output += `- **${text}**: ${count}\n`;
    }
    output += '\n';
  }

  return output;
};

export const exportLinkedDocAnnotations = (
  docAnnotations: Map<string, { annotations: Annotation[]; globalAttachments: ImageAttachment[] }>
): string => {
  let output = `\n# Linked Document Feedback\n\nThe following feedback is on documents referenced in the plan.\n\n`;

  for (const [filepath, { annotations, globalAttachments }] of docAnnotations) {
    if (annotations.length === 0 && globalAttachments.length === 0) continue;

    output += `## ${filepath}\n\n`;

    if (globalAttachments.length > 0) {
      output += `### Reference Images\n`;
      output += `Please review these reference images (use the Read tool to view):\n`;
      globalAttachments.forEach((img, idx) => {
        output += `${idx + 1}. [${img.name}] \`${img.path}\`\n`;
      });
      output += `\n`;
    }

    // Sort annotations by block and offset
    const sortedAnns = [...annotations].sort((a, b) => {
      if (a.blockId !== b.blockId) return a.blockId.localeCompare(b.blockId);
      return a.startOffset - b.startOffset;
    });

    output += `I've reviewed this document and have ${annotations.length} piece${annotations.length !== 1 ? 's' : ''} of feedback:\n\n`;

    sortedAnns.forEach((ann, index) => {
      output += `### ${index + 1}. `;

      switch (ann.type) {
        case 'DELETION':
          output += `Remove this\n`;
          output += `\`\`\`\n${ann.originalText}\n\`\`\`\n`;
          output += `> I don't want this in the document.\n`;
          break;

        case 'INSERTION':
          output += `Add this\n`;
          output += `\`\`\`\n${ann.text}\n\`\`\`\n`;
          break;

        case 'REPLACEMENT':
          output += `Change this\n`;
          output += `**From:**\n\`\`\`\n${ann.originalText}\n\`\`\`\n`;
          output += `**To:**\n\`\`\`\n${ann.text}\n\`\`\`\n`;
          break;

        case 'COMMENT':
          output += `Feedback on: "${ann.originalText}"\n`;
          output += `> ${ann.text}\n`;
          break;

        case 'GLOBAL_COMMENT':
          output += `General feedback about the document\n`;
          output += `> ${ann.text}\n`;
          break;
      }

      if (ann.images && ann.images.length > 0) {
        output += `**Attached images:**\n`;
        ann.images.forEach((img: ImageAttachment) => {
          output += `- [${img.name}] \`${img.path}\`\n`;
        });
      }

      output += '\n';
    });
  }

  output += `---\n`;
  return output;
};

export const exportEditorAnnotations = (editorAnnotations: EditorAnnotation[]): string => {
  if (editorAnnotations.length === 0) return '';

  let output = `\n# Editor File Annotations\n\nThe following annotations reference code files in the project.\n\n`;

  editorAnnotations.forEach((ann, index) => {
    const lineRange = ann.lineStart === ann.lineEnd
      ? `line ${ann.lineStart}`
      : `lines ${ann.lineStart}-${ann.lineEnd}`;

    output += `## ${index + 1}. ${ann.filePath} (${lineRange})\n`;
    output += `\`\`\`\n${ann.selectedText}\n\`\`\`\n`;

    if (ann.comment) {
      output += `> ${ann.comment}\n`;
    }

    output += '\n';
  });

  output += `---\n`;
  return output;
};