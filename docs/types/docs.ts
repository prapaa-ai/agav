export interface Doc {
  slug: string
  title: string
  description?: string
  content: string
  html?: string
  order?: number
  guideLevel?: 'beginner' | 'advanced'
  navHidden?: boolean
  headings?: Heading[]
}

export interface Heading {
  id: string
  text: string
  level: number
}

export interface NavItem {
  title: string
  slug: string
  order?: number
  children?: NavItem[]
  isGroup?: boolean
}

export interface SearchResult {
  slug: string
  title: string
  content: string
  headings?: string[]
}

export interface SearchIndex {
  documents: SearchResult[]
}
