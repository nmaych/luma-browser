import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react';
import type { ToastMessage } from '../../types';

interface ToastStackProps {
  toasts: ToastMessage[];
  onDismiss: (id: string) => void;
}

export function ToastStack({ toasts, onDismiss }: ToastStackProps) {
  return (
    <div className="toast-stack" aria-live="polite" aria-atomic="false">
      {toasts.map((toast) => (
        <div className={`toast toast--${toast.tone}`} key={toast.id} role="status">
          <span className="toast__icon">
            {toast.tone === 'success' ? <CheckCircle2 /> : toast.tone === 'error' ? <AlertCircle /> : <Info />}
          </span>
          <div className="toast__content">
            <strong>{toast.title}</strong>
            {toast.description && <p>{toast.description}</p>}
          </div>
          <button type="button" onClick={() => onDismiss(toast.id)} aria-label="关闭提示">
            <X size={16} />
          </button>
        </div>
      ))}
    </div>
  );
}
