export type ThemeManifest = {
  slug: string;
  name: string;
  version: string;
  author?: string;
  description?: string;
  templates?: {
    index?: string;
    post?: string;
    notFound?: string;
    search?: string;
  };
};

export type ThemeRecord = ThemeManifest & {
  bundled: boolean;
  installedAt: Date;
  active: boolean;
  dir: string;
};

export type SitePost = {
  slug: string;
  title: string;
  excerpt: string | null;
  contentHtml?: string;
  publishedAt: Date | null;
  authorName: string | null;
  commentsEnabled?: boolean;
};

export type SiteComment = {
  id: string;
  authorName: string;
  authorUrl: string | null;
  content: string;
  // `content` escaped with `\n` -> `<br>`; the only form safe for `<%~ %>`.
  contentHtml: string;
  createdAt: Date;
};

export type CommentFormState = {
  values: {
    authorName?: string;
    authorEmail?: string;
    authorUrl?: string;
    content?: string;
  };
  errors: Record<string, string>;
};

export type SiteUser = {
  id: string;
  email: string;
  displayName: string;
  role: string;
};

export type AuthFormState = {
  values: {
    email?: string;
    displayName?: string;
  };
  errors: Record<string, string>;
  error?: string;
};

export type RenderContext = {
  site: {
    title: string;
    description: string;
    faviconUrl: string | null;
  };
  theme: {
    slug: string;
    assetUrl: (path: string) => string;
  };
  url: {
    pathname: string;
    home: string;
    post: (slug: string) => string;
    admin: string;
    search: (q: string) => string;
  };
  posts?: SitePost[];
  post?: SitePost;
  comments?: SiteComment[];
  commentForm?: CommentFormState;
  currentUser: SiteUser | null;
  authForm?: AuthFormState;
  authRedirect?: string;
  commentSubmitted?: 'pending' | 'approved' | null;
  recaptchaSiteKey: string | null;
  search?: {
    query: string;
    total: number;
  };
  year: number;
};