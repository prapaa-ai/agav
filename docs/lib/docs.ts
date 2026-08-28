import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { markdownToHtml, extractHeadings } from "./markdown";
import type { Doc, NavItem } from "@/types/docs";

const docsDirectory = path.join(process.cwd(), "docs");

// Simple in-memory cache for development to speed up navigation
let docsCache: Doc[] | null = null;
let navTreeCache: NavItem[] | null = null;

export async function getAllDocs(): Promise<Doc[]> {
  // Return cached docs if available
  if (docsCache !== null) {
    return docsCache;
  }

  const docs: Doc[] = [];

  async function readDirectory(
    dir: string,
    basePath: string = "",
  ): Promise<void> {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        await readDirectory(fullPath, path.join(basePath, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        const fileContents = fs.readFileSync(fullPath, "utf8");
        const { data, content } = matter(fileContents);

        const fileName = entry.name.replace(/\.md$/, "");
        let slug = path
          .join(basePath, fileName === "index" ? "" : fileName)
          .replace(/\\/g, "/")
          .replace(/^\//, "")
          .replace(/^\.+$/, ""); // Remove standalone dots

        // Normalize: empty string or just dots becomes 'index'
        if (!slug || slug === ".") {
          slug = "index";
        }

        const html = await markdownToHtml(content);
        const headings = extractHeadings(content);

        docs.push({
          slug,
          title: data.title || fileName,
          description: data.description,
          content,
          html,
          order: data.order,
          guideLevel: data.guideLevel,
          navHidden: data.navHidden === true,
          headings,
        });
      }
    }
  }

  if (fs.existsSync(docsDirectory)) {
    await readDirectory(docsDirectory);
  }

  // Cache the result
  docsCache = docs;
  return docs;
}

export async function getDocBySlug(
  slug: string | string[],
): Promise<Doc | null> {
  const slugStr = Array.isArray(slug) ? slug.join("/") : slug;
  const docs = await getAllDocs();
  return docs.find((doc) => doc.slug === (slugStr || "index")) || null;
}

export async function getNavigationTree(): Promise<NavItem[]> {
  // Return cached navigation tree if available
  if (navTreeCache !== null) {
    return navTreeCache;
  }

  const docs = await getAllDocs();
  const tree: NavItem[] = [];

  const sectionTitles: Record<string, string> = {
    "getting-started": "Getting Started",
    workflows: "Workflows",
    features: "Features",
    guides: "Guides",
    reference: "Reference",
  };

  const titleizeSection = (part: string): string => {
    return (
      sectionTitles[part] ||
      part
        .split("-")
        .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
        .join(" ")
    );
  };

  for (const doc of docs) {
    if (doc.navHidden) continue;

    // Handle index page separately
    if (doc.slug === "index") {
      tree.push({
        title: doc.title,
        slug: doc.slug,
        order: doc.order,
      });
      continue;
    }

    const hasDescendants = docs.some((candidate) =>
      candidate.slug.startsWith(`${doc.slug}/`),
    );

    const isSectionRoot =
      !doc.slug.includes("/") && (hasDescendants || sectionTitles[doc.slug]);

    if (isSectionRoot) {
      let section = tree.find(
        (item) => item.slug === doc.slug && item.children,
      );

      if (!section) {
        section = {
          title: titleizeSection(doc.slug),
          slug: doc.slug,
          order: doc.order,
          children: [],
        };
        tree.push(section);
      }

      if (!section.children?.some((child) => child.slug === doc.slug)) {
        section.children = [
          ...(section.children || []),
          {
            title: doc.title,
            slug: doc.slug,
            order: 0,
          },
        ];
      }
      continue;
    }

    const parts = doc.slug.split("/");
    let current = tree;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;

      let existing = current.find((item) => {
        const itemParts = item.slug.split("/");
        return itemParts[i] === part && !isLast;
      });

      if (!existing && !isLast) {
        // Create intermediate node for directory
        const intermediateSlug = parts.slice(0, i + 1).join("/");
        const indexDoc = docs.find((d) => d.slug === intermediateSlug);

        existing = {
          title: titleizeSection(part),
          slug: intermediateSlug,
          order: indexDoc?.order,
          children: [],
        };
        current.push(existing);
      }

      if (isLast) {
        current.push({
          title: doc.title,
          slug: doc.slug,
          order: doc.order,
        });
      } else if (existing?.children) {
        current = existing.children;
      }
    }
  }

  // Keep guide URLs flat while presenting recipe groups in the sidebar.
  const guidesSection = tree.find((item) => item.slug === "guides");
  if (guidesSection?.children) {
    const groupedSlugs = new Set(
      docs
        .filter((doc) => doc.slug.startsWith("guides/") && doc.guideLevel)
        .map((doc) => doc.slug),
    );
    const groupedItems = guidesSection.children.filter((item) => groupedSlugs.has(item.slug));

    const beginnerItems = groupedItems.filter((item) =>
      docs.find((doc) => doc.slug === item.slug)?.guideLevel === "beginner"
    );
    const advancedItems = groupedItems.filter((item) =>
      docs.find((doc) => doc.slug === item.slug)?.guideLevel === "advanced"
    );

    guidesSection.children = [
      ...guidesSection.children.filter((item) => !groupedSlugs.has(item.slug)),
      ...(beginnerItems.length > 0 ? [{
        title: "Beginner",
        slug: "guides#beginner",
        order: 1,
        isGroup: true,
        children: beginnerItems,
      }] : []),
      ...(advancedItems.length > 0 ? [{
        title: "Advanced recipes",
        slug: "guides#advanced-recipes",
        order: 2,
        isGroup: true,
        children: advancedItems,
      }] : []),
    ];
  }

  // Define custom section order
  const sectionOrder: Record<string, number> = {
    index: 0,
    "getting-started": 1,
    features: 2,
    workflows: 3,
    guides: 4,
    reference: 5,
  };

  // Sort by custom section order, then by order field, then by title
  const sortNavItems = (items: NavItem[]): NavItem[] => {
    return items
      .sort((a, b) => {
        // Extract section from slug
        const aSectionSlug = a.slug.split("/")[0];
        const bSectionSlug = b.slug.split("/")[0];

        // Use custom section order if available
        const aSectionOrder = sectionOrder[aSectionSlug];
        const bSectionOrder = sectionOrder[bSectionSlug];

        if (aSectionOrder !== undefined && bSectionOrder !== undefined) {
          if (aSectionOrder !== bSectionOrder) {
            return aSectionOrder - bSectionOrder;
          }
        }

        // Within same section, sort by order field
        if (a.order !== undefined && b.order !== undefined) {
          return a.order - b.order;
        }
        if (a.order !== undefined) return -1;
        if (b.order !== undefined) return 1;

        // Finally sort by title
        return a.title.localeCompare(b.title);
      })
      .map((item) => ({
        ...item,
        children: item.children ? sortNavItems(item.children) : undefined,
      }));
  };

  const sortedTree = sortNavItems(tree);
  // Cache the result
  navTreeCache = sortedTree;
  return sortedTree;
}

// Helper to flatten navigation tree in display order
function flattenNavTree(tree: NavItem[]): NavItem[] {
  const result: NavItem[] = [];

  function traverse(items: NavItem[]) {
    for (const item of items) {
      if (!item.children || item.children.length === 0) {
        result.push(item);
      }
      if (item.children && item.children.length > 0) {
        traverse(item.children);
      }
    }
  }

  traverse(tree);
  return result;
}

export async function getAdjacentDocs(slug: string): Promise<{
  prev: Doc | null;
  next: Doc | null;
}> {
  const navigationTree = await getNavigationTree();
  const flatTree = flattenNavTree(navigationTree);

  const currentIndex = flatTree.findIndex((item) => item.slug === slug);

  if (currentIndex === -1) {
    return { prev: null, next: null };
  }

  const docs = await getAllDocs();

  const prevSlug = currentIndex > 0 ? flatTree[currentIndex - 1].slug : null;
  const nextSlug =
    currentIndex < flatTree.length - 1 ? flatTree[currentIndex + 1].slug : null;

  return {
    prev: prevSlug ? docs.find((d) => d.slug === prevSlug) || null : null,
    next: nextSlug ? docs.find((d) => d.slug === nextSlug) || null : null,
  };
}
