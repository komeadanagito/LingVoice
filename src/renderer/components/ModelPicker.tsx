import { useEffect, useState } from 'react';
import type { ProviderModelsEntry } from '../hooks/useProviderModels';
import { Select, type SelectOption } from './Select';

export interface ModelPickerProps {
  providerId: string;
  value: string;
  onChange: (value: string) => void;
  entry?: ProviderModelsEntry;
  onFetch: () => void;
  supportsModels: boolean;
  disabled?: boolean;
  placeholder?: string;
  zh: boolean;
  id?: string;
}

export function ModelPicker({ providerId, value, onChange, entry, onFetch, supportsModels, disabled, placeholder, zh, id }: ModelPickerProps) {
  // Key manual mode by provider so switching providers restores discovery mode.
  const [manualProvider, setManualProvider] = useState<string | null>(null);
  useEffect(() => { setManualProvider(null); }, [providerId]);
  const models = [...new Set(entry?.models ?? [])];
  const hasList = models.length > 0;
  const manual = manualProvider === providerId;
  const showList = hasList && !manual;
  const modelLabel = zh ? '模型名称' : 'Model name';
  const isModelInList = models.includes(value);
  const manualOption: SelectOption = {
    value: isModelInList ? '__manual_input__' : value,
    label: !isModelInList && value ? (zh ? `手动填写: ${value}` : `Manual: ${value}`) : (zh ? '手动填写…' : 'Enter manually…'),
  };

  const options: SelectOption[] = [
    manualOption,
    ...models.map(model => ({ value: model, label: model })),
  ];

  const handleSelect = (selected: string) => {
    if (selected === manualOption.value) {
      setManualProvider(providerId);
    } else {
      setManualProvider(null);
      onChange(selected);
    }
  };

  return <div className="model-picker">
    <div className="model-input">
      {showList ? <Select
        id={id}
        value={value}
        options={options}
        onChange={handleSelect}
        disabled={disabled}
        aria-label={modelLabel}
      /> : <input
        id={id}
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-label={modelLabel}
        onChange={event => onChange(event.target.value)}
        autoFocus={manual}
      />}
      {hasList && manual && <button
        type="button"
        className="choose-file-button"
        disabled={disabled}
        onClick={() => setManualProvider(null)}
      >{zh ? '从列表选择' : 'From list'}</button>}
      <button
        type="button"
        className="choose-file-button fetch-models"
        disabled={disabled || !providerId || !supportsModels || entry?.loading}
        onClick={onFetch}
      >{entry?.loading ? (zh ? '获取中…' : 'Fetching…') : entry?.loaded ? (zh ? '刷新模型' : 'Refresh models') : (zh ? '获取模型' : 'Fetch models')}</button>
    </div>
    {entry?.error ? <p className="model-feedback error" role="alert">{entry.error}</p>
      : entry?.loading ? <p className="model-feedback" role="status">{zh ? '正在获取服务商的模型列表…' : 'Fetching the provider’s model list…'}</p>
      : !supportsModels && providerId ? <p className="model-feedback" role="status">{zh ? '此服务商不支持获取模型列表，请手动输入模型名称。' : 'This provider does not support model discovery. Enter a model name manually.'}</p> : null}
  </div>;
}
