/**
 * Unit tests for RBAC layer.
 *
 * Tests verify:
 * - Role permissions are correct
 * - Permission checking works
 * - Default deny behavior
 * - Sensitive data masking
 * - Read-only role enforcement
 * - Admin/customer separation
 */

import {
  hasPermission,
  canReadAdminData,
  canManageAdmins,
  canRunOperations,
  canInvestigate,
  isReadOnly,
  getFieldsToMask,
  ROLE_PERMISSIONS,
  maskSensitiveFields,
  maskArray,
} from '../rbac/types';
import type { AdminRole, Permission } from '../rbac/types';

describe('RBAC Layer', () => {
  describe('SuperAdmin Permissions', () => {
    const role: AdminRole = 'SuperAdmin';

    it('should have all permissions', () => {
      expect(hasPermission(role, 'admins:create')).toBe(true);
      expect(hasPermission(role, 'admins:delete')).toBe(true);
      expect(hasPermission(role, 'transfers:retry')).toBe(true);
      expect(hasPermission(role, 'users:search')).toBe(true);
      expect(hasPermission(role, 'audit_logs:export')).toBe(true);
    });

    it('should be able to read admin data', () => {
      expect(canReadAdminData(role)).toBe(true);
    });

    it('should be able to manage admins', () => {
      expect(canManageAdmins(role)).toBe(true);
    });

    it('should be able to run operations', () => {
      expect(canRunOperations(role)).toBe(true);
    });

    it('should be able to investigate', () => {
      expect(canInvestigate(role)).toBe(true);
    });

    it('should not be read-only', () => {
      expect(isReadOnly(role)).toBe(false);
    });

    it('should not mask any fields', () => {
      expect(getFieldsToMask(role, 'users')).toEqual([]);
      expect(getFieldsToMask(role, 'bank_accounts')).toEqual([]);
    });
  });

  describe('OperationsAdmin Permissions', () => {
    const role: AdminRole = 'OperationsAdmin';

    it('should have operation permissions', () => {
      expect(hasPermission(role, 'transfers:retry')).toBe(true);
      expect(hasPermission(role, 'transfers:cancel')).toBe(true);
      expect(hasPermission(role, 'events:replay')).toBe(true);
      expect(hasPermission(role, 'settlements:view')).toBe(true);
    });

    it('should NOT have admin management permissions', () => {
      expect(hasPermission(role, 'admins:create')).toBe(false);
      expect(hasPermission(role, 'admins:delete')).toBe(false);
      expect(hasPermission(role, 'roles:manage')).toBe(false);
    });

    it('should be able to run operations', () => {
      expect(canRunOperations(role)).toBe(true);
    });

    it('should NOT be able to manage admins', () => {
      expect(canManageAdmins(role)).toBe(false);
    });

    it('should NOT be read-only', () => {
      expect(isReadOnly(role)).toBe(false);
    });
  });

  describe('FinancialInvestigator Permissions', () => {
    const role: AdminRole = 'FinancialInvestigator';

    it('should have investigation permissions', () => {
      expect(hasPermission(role, 'users:search')).toBe(true);
      expect(hasPermission(role, 'users:view_details')).toBe(true);
      expect(hasPermission(role, 'transfers:view')).toBe(true);
      expect(hasPermission(role, 'ledger:view')).toBe(true);
      expect(hasPermission(role, 'investigations:create_notes')).toBe(true);
    });

    it('should NOT have operation permissions', () => {
      expect(hasPermission(role, 'transfers:retry')).toBe(false);
      expect(hasPermission(role, 'transfers:cancel')).toBe(false);
      expect(hasPermission(role, 'events:replay')).toBe(false);
    });

    it('should be able to investigate', () => {
      expect(canInvestigate(role)).toBe(true);
    });

    it('should NOT be able to run operations', () => {
      expect(canRunOperations(role)).toBe(false);
    });

    it('should NOT be read-only', () => {
      expect(isReadOnly(role)).toBe(false);
    });
  });

  describe('ComplianceOfficer Permissions', () => {
    const role: AdminRole = 'ComplianceOfficer';

    it('should have compliance permissions', () => {
      expect(hasPermission(role, 'audit_logs:read')).toBe(true);
      expect(hasPermission(role, 'audit_logs:export')).toBe(true);
      expect(hasPermission(role, 'incidents:review')).toBe(true);
      expect(hasPermission(role, 'compliance:read')).toBe(true);
    });

    it('should NOT have operation permissions', () => {
      expect(hasPermission(role, 'transfers:retry')).toBe(false);
      expect(hasPermission(role, 'transfers:cancel')).toBe(false);
    });

    it('should be read-only', () => {
      expect(isReadOnly(role)).toBe(true);
    });

    it('should NOT be able to run operations', () => {
      expect(canRunOperations(role)).toBe(false);
    });
  });

  describe('ReadOnlyAuditor Permissions', () => {
    const role: AdminRole = 'ReadOnlyAuditor';

    it('should have only read-only permissions', () => {
      expect(hasPermission(role, 'audit_logs:read_masked')).toBe(true);
      expect(hasPermission(role, 'data:read_masked')).toBe(true);
    });

    it('should NOT have write permissions', () => {
      expect(hasPermission(role, 'admins:create')).toBe(false);
      expect(hasPermission(role, 'transfers:retry')).toBe(false);
      expect(hasPermission(role, 'investigations:create_notes')).toBe(false);
    });

    it('should be read-only', () => {
      expect(isReadOnly(role)).toBe(true);
    });

    it('should NOT be able to investigate', () => {
      expect(canInvestigate(role)).toBe(false);
    });

    it('should mask sensitive fields', () => {
      const masked = getFieldsToMask(role, 'users');
      expect(masked.length).toBeGreaterThan(0);
      expect(masked).toContain('email');
      expect(masked).toContain('phone');
    });
  });

  describe('Permission Checking', () => {
    it('should correctly check role permissions', () => {
      expect(hasPermission('SuperAdmin', 'admins:create')).toBe(true);
      expect(hasPermission('OperationsAdmin', 'admins:create')).toBe(false);
      expect(hasPermission('FinancialInvestigator', 'admins:create')).toBe(false);
    });

    it('should return false for invalid permissions', () => {
      expect(hasPermission('SuperAdmin', 'invalid:permission' as Permission)).toBe(false);
    });

    it('should enforce default deny', () => {
      const readOnlyAuditorPermissions = ROLE_PERMISSIONS['ReadOnlyAuditor'];
      expect(readOnlyAuditorPermissions).toBeDefined();
      expect(readOnlyAuditorPermissions.length).toBeLessThan(50);
      // Many permissions should NOT be in ReadOnlyAuditor
      expect(readOnlyAuditorPermissions).not.toContain('admins:create');
      expect(readOnlyAuditorPermissions).not.toContain('transfers:retry');
    });
  });

  describe('Role Capabilities', () => {
    it('should correctly identify SuperAdmin', () => {
      expect(canReadAdminData('SuperAdmin')).toBe(true);
      expect(canManageAdmins('SuperAdmin')).toBe(true);
      expect(canRunOperations('SuperAdmin')).toBe(true);
      expect(canInvestigate('SuperAdmin')).toBe(true);
      expect(isReadOnly('SuperAdmin')).toBe(false);
    });

    it('should correctly identify OperationsAdmin', () => {
      expect(canManageAdmins('OperationsAdmin')).toBe(false);
      expect(canRunOperations('OperationsAdmin')).toBe(true);
      expect(isReadOnly('OperationsAdmin')).toBe(false);
    });

    it('should correctly identify read-only roles', () => {
      expect(isReadOnly('ReadOnlyAuditor')).toBe(true);
      expect(isReadOnly('ComplianceOfficer')).toBe(true);
      expect(isReadOnly('SuperAdmin')).toBe(false);
      expect(isReadOnly('OperationsAdmin')).toBe(false);
      expect(isReadOnly('FinancialInvestigator')).toBe(false);
    });
  });

  describe('Sensitive Data Masking', () => {
    it('should mask email for non-SuperAdmin', () => {
      const data = { id: 1, email: 'alice@example.com', name: 'Alice' };

      const masked = maskSensitiveFields(data, 'users', 'ReadOnlyAuditor');
      expect(masked.email).toMatch(/^a\*\*\*@example\.com$/);
      expect(masked.name).toBe('Alice');
    });

    it('should mask phone for non-SuperAdmin', () => {
      const data = { id: 1, phone: '555-1234-5678', name: 'Alice' };

      const masked = maskSensitiveFields(data, 'users', 'ReadOnlyAuditor');
      expect(masked.phone).toBe('***-***-****');
    });

    it('should mask account_mask for non-SuperAdmin', () => {
      const data = { id: 1, account_mask: '1234567890123456', name: 'Account' };

      const masked = maskSensitiveFields(data, 'bank_accounts', 'FinancialInvestigator');
      expect(masked.account_mask).toMatch(/^\*\*\*\*\d{4}$/);
    });

    it('should mask IP address for non-SuperAdmin', () => {
      const data = { id: 1, ip_address: '192.168.1.100', name: 'Log' };

      const masked = maskSensitiveFields(data, 'admin_audit_logs', 'ReadOnlyAuditor');
      expect(masked.ip_address).toBe('192.168.1.***');
    });

    it('should NOT mask for SuperAdmin', () => {
      const data = { id: 1, email: 'alice@example.com', phone: '555-1234-5678' };

      const masked = maskSensitiveFields(data, 'users', 'SuperAdmin');
      expect(masked.email).toBe('alice@example.com');
      expect(masked.phone).toBe('555-1234-5678');
    });

    it('should mask arrays of objects', () => {
      const data = [
        { id: 1, email: 'alice@example.com', name: 'Alice' },
        { id: 2, email: 'bob@example.com', name: 'Bob' },
      ];

      const masked = maskArray(data, 'users', 'ReadOnlyAuditor');
      expect(masked.length).toBe(2);
      expect(masked[0].email).toMatch(/^a\*\*\*@example\.com$/);
      expect(masked[1].email).toMatch(/^b\*\*\*@example\.com$/);
    });

    it('should handle missing fields gracefully', () => {
      const data = { id: 1, name: 'Alice' }; // No email, phone

      const masked = maskSensitiveFields(data, 'users', 'ReadOnlyAuditor');
      expect(masked.name).toBe('Alice');
      expect(masked.email).toBeUndefined(); // Missing field, not added
    });
  });

  describe('Architecture Validation', () => {
    it('should separate admin and customer auth', () => {
      // RBAC types are separate from user types
      const adminRole: AdminRole = 'SuperAdmin';
      expect(adminRole).toBeDefined();

      // ROLE_PERMISSIONS should only apply to admin roles
      expect(ROLE_PERMISSIONS['SuperAdmin']).toBeDefined();
      expect(ROLE_PERMISSIONS['InvalidRole' as AdminRole]).toBeUndefined();
    });

    it('should enforce default deny principle', () => {
      // Check that not having a permission is the default state
      const allPermissions = Object.values(ROLE_PERMISSIONS)
        .flat()
        .filter((p, i, arr) => arr.indexOf(p) === i);

      for (const role of ['ReadOnlyAuditor', 'ComplianceOfficer'] as const) {
        const rolePerms = ROLE_PERMISSIONS[role];

        // These roles should have minimal permissions
        expect(rolePerms.length).toBeLessThan(10);

        // They should NOT have admin management
        expect(rolePerms).not.toContain('admins:create');
        expect(rolePerms).not.toContain('admins:delete');
        expect(rolePerms).not.toContain('roles:manage');
      }
    });

    it('should have no permission overlap with customer auth', () => {
      // Admin permissions should be completely separate from customer permissions
      const adminPermissions = Object.values(ROLE_PERMISSIONS)
        .flat()
        .filter((p, i, arr) => arr.indexOf(p) === i);

      // None of these should be customer-facing
      for (const perm of adminPermissions) {
        expect(perm).toMatch(/^(admins|transfers|events|settlements|audit|compliance|investigations|users|wallets|ledger|provider|incidents|exceptions):/);
      }
    });
  });

  describe('Role Permissions Completeness', () => {
    it('should have permissions for all roles', () => {
      const roles: AdminRole[] = [
        'SuperAdmin',
        'OperationsAdmin',
        'FinancialInvestigator',
        'ComplianceOfficer',
        'ReadOnlyAuditor',
      ];

      for (const role of roles) {
        expect(ROLE_PERMISSIONS[role]).toBeDefined();
        expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
        expect(ROLE_PERMISSIONS[role].length).toBeGreaterThan(0);
      }
    });

    it('should not have empty permission arrays', () => {
      for (const [role, perms] of Object.entries(ROLE_PERMISSIONS)) {
        expect(perms.length).toBeGreaterThan(0);
      }
    });

    it('should have meaningful permission hierarchy', () => {
      const superAdminPerms = ROLE_PERMISSIONS['SuperAdmin'];
      const opsAdminPerms = ROLE_PERMISSIONS['OperationsAdmin'];

      // SuperAdmin should have strictly more permissions
      expect(superAdminPerms.length).toBeGreaterThan(opsAdminPerms.length);

      // OpsAdmin permissions should be subset of SuperAdmin
      for (const perm of opsAdminPerms) {
        expect(superAdminPerms).toContain(perm);
      }
    });
  });
});
