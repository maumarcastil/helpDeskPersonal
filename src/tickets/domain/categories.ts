/**
 * Fixed, non-overlapping category/subcategory taxonomy (spec
 * `ticket-lifecycle` -> Requirement "Category and Subcategory Taxonomy").
 */
export type Category =
  | "access-identity"
  | "infrastructure-software"
  | "provisioning-permissions";

export type Subcategory =
  | "account-locked"
  | "password-reset"
  | "mfa"
  | "inactive-account"
  | "vpn"
  | "performance"
  | "corporate-app"
  | "folder-repo-access"
  | "license"
  | "profile-change";

export const CATEGORY_SUBCATEGORIES: Readonly<
  Record<Category, readonly Subcategory[]>
> = {
  "access-identity": [
    "account-locked",
    "password-reset",
    "mfa",
    "inactive-account",
  ],
  "infrastructure-software": ["vpn", "performance", "corporate-app"],
  "provisioning-permissions": [
    "folder-repo-access",
    "license",
    "profile-change",
  ],
} as const;

export function isSubcategoryOfCategory(
  category: Category,
  subcategory: Subcategory,
): boolean {
  return (CATEGORY_SUBCATEGORIES[category] as readonly Subcategory[]).includes(
    subcategory,
  );
}
