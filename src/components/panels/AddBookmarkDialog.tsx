import { useEffect, useState, type FormEvent } from 'react';
import { Folder, FolderPlus, Star } from 'lucide-react';
import type { BookmarkFolder } from '../../types';
import { Modal } from '../common/Modal';

interface AddBookmarkDialogProps {
  initialUrl?: string;
  initialTitle?: string;
  initialFolderId?: string;
  folders?: BookmarkFolder[];
  onAdd: (title: string, url: string, folderId?: string) => boolean;
  onAddFolder?: (name: string) => string | null;
  onClose: () => void;
}

const NEW_FOLDER_OPTION = '__new_folder__';

export function AddBookmarkDialog({
  initialUrl = '',
  initialTitle = '',
  initialFolderId = '',
  folders = [],
  onAdd,
  onAddFolder,
  onClose,
}: AddBookmarkDialogProps) {
  const [title, setTitle] = useState(initialTitle);
  const [url, setUrl] = useState(initialUrl);
  const [folderId, setFolderId] = useState(initialFolderId);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');

  useEffect(() => {
    setTitle(initialTitle);
    setUrl(initialUrl);
    setFolderId(initialFolderId);
    setCreatingFolder(false);
    setNewFolderName('');
  }, [initialTitle, initialUrl, initialFolderId]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (onAdd(title, url, folderId || undefined)) onClose();
  };

  const createFolder = () => {
    if (!onAddFolder || !newFolderName.trim()) return;
    const id = onAddFolder(newFolderName);
    if (!id) return;
    setFolderId(id);
    setCreatingFolder(false);
    setNewFolderName('');
  };

  return (
    <Modal
      title="添加书签"
      description="保存一个常用页面，并选择要放入的文件夹。"
      onClose={onClose}
      footer={<><button className="secondary-button" type="button" onClick={onClose}>取消</button><button className="primary-button" type="submit" form="add-bookmark-form" disabled={!url.trim()}><Star size={16} /> 保存书签</button></>}
    >
      <form id="add-bookmark-form" className="bookmark-form" onSubmit={submit}>
        <label><span>名称</span><input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：开发文档" maxLength={80} /></label>
        <label><span>网址 <b>*</b></span><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://example.com" inputMode="url" required /></label>
        <label>
          <span>文件夹</span>
          <span className="bookmark-folder-select">
            <Folder size={15} />
            <select
              aria-label="书签文件夹"
              value={creatingFolder ? NEW_FOLDER_OPTION : folderId}
              onChange={(event) => {
                if (event.target.value === NEW_FOLDER_OPTION) {
                  setCreatingFolder(true);
                  setFolderId('');
                } else {
                  setCreatingFolder(false);
                  setFolderId(event.target.value);
                }
              }}
            >
              <option value="">未分类</option>
              {folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}
              {onAddFolder && <option value={NEW_FOLDER_OPTION}>＋ 新建文件夹…</option>}
            </select>
          </span>
        </label>
        {creatingFolder && (
          <div className="bookmark-new-folder">
            <FolderPlus size={16} />
            <input
              autoFocus
              aria-label="新文件夹名称"
              value={newFolderName}
              onChange={(event) => setNewFolderName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  createFolder();
                }
              }}
              placeholder="输入新文件夹名称"
              maxLength={40}
            />
            <button type="button" onClick={createFolder} disabled={!newFolderName.trim()}>创建</button>
          </div>
        )}
        <p>支持 http、https、file:// 本地文件以及 luma:// 内置页面地址。</p>
      </form>
    </Modal>
  );
}
