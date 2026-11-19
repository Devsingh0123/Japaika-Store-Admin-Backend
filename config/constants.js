export const ADMIN_ROLES = Object.freeze({
  SUPER_ADMIN: 'super_admin',
  CATALOG_MANAGER: 'catalog_manager',
  OPERATIONS_MANAGER: 'operations_manager',
  SUPPORT_MODERATOR: 'support_moderator',
});

export const ALL_ADMIN_ROLES = Object.freeze(Object.values(ADMIN_ROLES));

export const ADMIN_STATUSES = Object.freeze({
  ACTIVE: 'active',
  SUSPENDED: 'suspended',
});

export const ALL_ADMIN_STATUSES = Object.freeze(Object.values(ADMIN_STATUSES));
