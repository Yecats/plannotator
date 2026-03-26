import React, { useState, useRef, useEffect, useCallback } from 'react';
import { type Block } from '../types';
import { blockToMarkdown } from '../utils/parser';

interface EditableBlockProps {
  block: Block;
  editMode: boolean;
  editedContent: string | undefined;
  onEdit: (blockId: string, newContent: string) => void;
  children: React.ReactNode;
}

/**
 * Wraps a rendered block with click-to-edit behavior in edit mode.
 * When clicked, replaces the rendered content with a textarea
 * pre-filled with the block's markdown source.
 */
export const EditableBlock: React.FC<EditableBlockProps> = ({
  block,
  editMode,
  editedContent,
  onEdit,
  children,
}) => {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isEdited = editedContent !== undefined;

  const startEditing = useCallback(() => {
    if (!editMode) return;
    const source = editedContent ?? blockToMarkdown(block);
    setDraft(source);
    setEditing(true);
  }, [editMode, editedContent, block]);

  const saveEdit = useCallback(() => {
    const original = blockToMarkdown(block);
    if (draft.trim() !== original.trim()) {
      onEdit(block.id, draft);
    }
    setEditing(false);
  }, [draft, block, onEdit]);

  const cancelEdit = useCallback(() => {
    setEditing(false);
  }, []);

  // Auto-focus and auto-resize textarea
  useEffect(() => {
    if (editing && textareaRef.current) {
      const ta = textareaRef.current;
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
    }
  }, [editing]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        cancelEdit();
      } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        saveEdit();
      }
    },
    [cancelEdit, saveEdit]
  );

  const handleInput = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value);
    // Auto-resize
    const ta = e.target;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }, []);

  // Textarea styling varies by block type
  const getTextareaClass = (): string => {
    const base = 'w-full bg-transparent border-none outline-none resize-none p-0 m-0 leading-relaxed';
    switch (block.type) {
      case 'heading':
        if (block.level === 1) return `${base} text-2xl font-bold`;
        if (block.level === 2) return `${base} text-xl font-bold`;
        if (block.level === 3) return `${base} text-lg font-semibold`;
        return `${base} text-base font-semibold`;
      case 'code':
        return `${base} font-mono text-sm`;
      case 'blockquote':
        return `${base} italic`;
      default:
        return base;
    }
  };

  if (editing) {
    return (
      <div className="relative group w-full" data-editing="true">
        <textarea
          ref={textareaRef}
          value={draft}
          onChange={handleInput}
          onBlur={saveEdit}
          onKeyDown={handleKeyDown}
          className={getTextareaClass()}
          style={{
            ...(block.type === 'list-item' ? { marginLeft: `${(block.level ?? 0) * 1.5}rem` } : {}),
            minHeight: '1.5em',
          }}
          spellCheck
        />
        <div className="absolute -top-6 right-0 text-xs opacity-60 pointer-events-none">
          Ctrl+Enter to save · Esc to cancel
        </div>
      </div>
    );
  }

  if (!editMode) {
    return <>{children}</>;
  }

  // Edit mode but not actively editing: show block with hover indicator
  return (
    <div
      className={`relative w-full cursor-text rounded-sm ${
        isEdited
          ? 'outline outline-2 outline-offset-2 outline-blue-400/40'
          : 'hover:outline hover:outline-1 hover:outline-offset-2 hover:outline-gray-400/30'
      }`}
      onClick={startEditing}
      title="Click to edit"
    >
      {children}
      {isEdited && (
        <span className="absolute -left-4 top-0 text-blue-400 text-xs opacity-70" title="Edited">
          ✎
        </span>
      )}
    </div>
  );
};
