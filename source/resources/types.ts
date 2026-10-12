/** Optional methods are capabilities: the UI never invents unsupported operations. */
export interface ResourceItem {
  id: string;
  title: string;
  description: string;
  detail: string;
  searchText?: string;
  enabled?: boolean;
  removable?: boolean;
  values?: Record<string, string>;
}

export interface ResourceField {
  name: string;
  label: string;
  required?: boolean;
  options?: readonly string[];
}

export interface ResourceAdapter {
  title: string;
  list(): Promise<ResourceItem[]>;
  get(id: string): Promise<ResourceItem | undefined>;
  fields?: ResourceField[];
  create?(values: Record<string, string>): Promise<void | string>;
  update?(id: string, values: Record<string, string>): Promise<void>;
  remove?(id: string): Promise<void>;
  setEnabled?(id: string, enabled: boolean): Promise<void>;
  notice?: string;
}

export type ResourceKind = "agents" | "skills" | "memory" | "schedule" | "history" | "search-history";

export function filterResources(items: ResourceItem[], query: string): ResourceItem[] {
  const q = query.toLowerCase();
  return items.filter((item) => [item.title, item.description, item.searchText ?? ""].some((text) => text.toLowerCase().includes(q)));
}

export function resourcePage(index: number, count: number, size: number) {
  const selected = Math.max(0, Math.min(index, Math.max(0, count - 1)));
  return { selected, page: Math.floor(selected / size), pages: Math.max(1, Math.ceil(count / size)) };
}
