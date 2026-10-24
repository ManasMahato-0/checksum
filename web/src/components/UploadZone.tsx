import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { api } from '../lib/api';
import { useAccount } from '../lib/account';
import { keys } from '../lib/queries';
import { Icon } from './Icon';
import { useToast } from './Toast';

/** Drag-and-drop (or click) a statement; the server answers immediately and processes in the background. */
export function UploadZone({ onUploaded }: { onUploaded?: (importId: string) => void }) {
  const { account } = useAccount();
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);

  const upload = useMutation({
    mutationFn: (file: File) => api.upload(account, file),
    onSuccess: (res, file) => {
      void qc.invalidateQueries({ queryKey: keys.imports(account) });
      if (res.status === 'duplicate_file') {
        toast('warning', <>Already imported <strong>{file.name}</strong>. Nothing changed.</>);
      } else {
        toast('good', <>Uploaded <strong>{file.name}</strong>. Processing in the background.</>);
      }
      onUploaded?.(res.importId);
    },
    onError: (e, file) => toast('critical', <>Could not import <strong>{file.name}</strong>: {e.message}</>),
  });

  const pick = (files: FileList | null) => {
    const file = files?.[0];
    if (file) upload.mutate(file);
  };

  return (
    <div
      className={`drop${over ? ' over' : ''}`}
      role="button"
      tabIndex={0}
      aria-label="Upload a bank statement CSV"
      onClick={() => input.current?.click()}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        pick(e.dataTransfer.files);
      }}
    >
      <Icon name={upload.isPending ? 'spinner' : 'upload'} size={24} />
      <strong>{upload.isPending ? 'Uploading…' : 'Drop a statement here, or click to choose'}</strong>
      <p>HDFC or SBI CSV export, up to 5 MB. Re-uploading the same file is safe.</p>
      <input
        ref={input}
        type="file"
        accept=".csv,.txt,text/csv"
        hidden
        onChange={(e) => {
          pick(e.target.files);
          e.target.value = '';
        }}
      />
    </div>
  );
}
