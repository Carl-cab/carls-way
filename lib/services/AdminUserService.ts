/**
 * Admin User Service
 *
 * Read-only access to admin user information and activity.
 * Used by Operations Console for admin management views.
 */

import { getCurrentAdmin, checkPermission } from '@/lib/rbac';
import { getAdminRepository } from '@/lib/rbac';
import type { AdminUser, AdminRole } from '@/lib/rbac/types';

export interface AdminUserDTO {
  id: number;
  email: string;
  name: string;
  role: string;
  status: string;
  last_login_at?: string;
  failed_login_attempts: number;
  locked_until?: string;
  created_at: string;
  updated_at: string;
}

export interface AdminUserListResponse {
  admins: AdminUserDTO[];
  total_count: number;
  page: number;
  page_size: number;
}

export class AdminUserService {
  private repo = getAdminRepository();

  /**
   * Get all admin users (paginated).
   * Requires admins:read permission.
   */
  async listAdmins(
    page: number = 1,
    pageSize: number = 50
  ): Promise<AdminUserListResponse> {
    if (!checkPermission('admins:read')) {
      throw new Error('Permission denied: admins:read');
    }

    const limit = Math.min(pageSize, 100);

    // Fetch all admins and paginate in memory
    // In a production app, the repository would support offset/limit directly
    const allAdmins = await this.repo.findAllAdmins(1000);
    const offset = (page - 1) * limit;
    const records = allAdmins.slice(offset, offset + limit);

    return {
      admins: records.map((a) => this.toDTO(a)),
      total_count: allAdmins.length,
      page,
      page_size: limit,
    };
  }

  /**
   * Get a specific admin by ID.
   * Requires admins:read permission.
   */
  async getAdminById(id: number): Promise<AdminUserDTO | null> {
    if (!checkPermission('admins:read')) {
      throw new Error('Permission denied: admins:read');
    }

    const admin = await this.repo.findAdminById(id);
    return admin ? this.toDTO(admin) : null;
  }

  /**
   * Get admins by role.
   * Requires admins:read permission.
   */
  async getAdminsByRole(role: string): Promise<AdminUserDTO[]> {
    if (!checkPermission('admins:read')) {
      throw new Error('Permission denied: admins:read');
    }

    const admins = await this.repo.findAdminsByRole(role as AdminRole);
    return admins.map((a) => this.toDTO(a));
  }

  /**
   * Get count of admins by role.
   * Requires admins:read permission.
   */
  async getAdminCountByRole(): Promise<Record<string, number>> {
    if (!checkPermission('admins:read')) {
      throw new Error('Permission denied: admins:read');
    }

    return this.repo.countByRole();
  }

  /**
   * Convert admin to DTO (no sensitive data).
   */
  private toDTO(admin: AdminUser): AdminUserDTO {
    return {
      id: admin.id,
      email: admin.email,
      name: admin.name,
      role: admin.role,
      status: admin.status,
      last_login_at: admin.last_login_at,
      failed_login_attempts: admin.failed_login_attempts,
      locked_until: admin.locked_until,
      created_at: admin.created_at,
      updated_at: admin.updated_at,
    };
  }
}

export function getAdminUserService(): AdminUserService {
  return new AdminUserService();
}
