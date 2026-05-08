import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { useState } from 'react';

type Props = {
  initialHtml?: string;
  name: string;
};

export default function TiptapEditor({ initialHtml = '', name }: Props) {
  const [html, setHtml] = useState(initialHtml);

  const editor = useEditor({
    extensions: [StarterKit],
    content: initialHtml,
    immediatelyRender: false,
    onUpdate: ({ editor }) => setHtml(editor.getHTML()),
  });

  if (!editor) return null;

  const btn = (active: boolean, onClick: () => void, label: string, title: string) => (
    <button type="button" className={active ? 'is-active' : ''} onClick={onClick} title={title}>
      {label}
    </button>
  );

  const setLink = () => {
    const prev = editor.getAttributes('link').href as string | undefined;
    const url = window.prompt('URL', prev ?? 'https://');
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
  };

  return (
    <div className="editor-wrapper">
      <div className="editor-toolbar">
        {btn(editor.isActive('bold'), () => editor.chain().focus().toggleBold().run(), 'B', 'Bold')}
        {btn(editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run(), 'I', 'Italic')}
        {btn(editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run(), 'S', 'Strikethrough')}
        {btn(editor.isActive('code'), () => editor.chain().focus().toggleCode().run(), '<>', 'Inline code')}
        <span style={{ width: 1, background: 'var(--border)', margin: '0 4px' }} />
        {btn(editor.isActive('heading', { level: 1 }), () => editor.chain().focus().toggleHeading({ level: 1 }).run(), 'H1', 'Heading 1')}
        {btn(editor.isActive('heading', { level: 2 }), () => editor.chain().focus().toggleHeading({ level: 2 }).run(), 'H2', 'Heading 2')}
        {btn(editor.isActive('heading', { level: 3 }), () => editor.chain().focus().toggleHeading({ level: 3 }).run(), 'H3', 'Heading 3')}
        <span style={{ width: 1, background: 'var(--border)', margin: '0 4px' }} />
        {btn(editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run(), '• List', 'Bullet list')}
        {btn(editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run(), '1. List', 'Numbered list')}
        {btn(editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run(), 'Quote', 'Blockquote')}
        {btn(editor.isActive('codeBlock'), () => editor.chain().focus().toggleCodeBlock().run(), 'Code block', 'Code block')}
        <span style={{ width: 1, background: 'var(--border)', margin: '0 4px' }} />
        {btn(editor.isActive('link'), setLink, 'Link', 'Add or edit link')}
        {btn(false, () => editor.chain().focus().setHorizontalRule().run(), '― Rule', 'Horizontal rule')}
      </div>
      <EditorContent editor={editor} />
      <input type="hidden" name={name} value={html} />
    </div>
  );
}