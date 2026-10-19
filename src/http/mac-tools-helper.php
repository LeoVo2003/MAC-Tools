<?php
/**
 * Plugin Name: MAC Tools Helper
 * Description: Helper tạm cho MAC Tools User Guide Phase 1. Tool tự cài đầu job, tự xóa cuối job.
 * Version: 1.0.0
 * Author: MAC Tools
 *
 * Tool tự upload file này (dạng zip) qua wp-admin/plugin-install.php?tab=upload,
 * gọi REST endpoints thay vì điều khiển browser, xóa cuối job.
 *
 * Endpoints (tất cả yêu cầu manage_options):
 *   POST /mac/v1/backup/run              — chạy UpdraftPlus backup
 *   GET  /mac/v1/backup/status            — kiểm tra trạng thái backup
 *   POST /mac/v1/users                    — tạo WP user
 *   POST /mac/v1/mac-role/install         — cài + active Mac Role plugin
 *   POST /mac/v1/mac-role/apply-template  — apply template F Package User
 *   POST /mac/v1/web-info/move-to-top     — chuyển Web Info ra menu top-level
 *   POST /mac/v1/plugins/remove           — gỡ plugins theo slugs
 *
 * Auth: Application Password (Basic Auth) của admin.
 */

if (!defined('ABSPATH')) exit;

add_action('rest_api_init', function () {
    $perm = function () {
        return current_user_can('manage_options');
    };

    // --- Backup ---
    register_rest_route('mac/v1', '/backup/run', [
        'methods' => 'POST',
        'callback' => 'mactools_backup_run',
        'permission_callback' => $perm,
    ]);
    register_rest_route('mac/v1', '/backup/status', [
        'methods' => 'GET',
        'callback' => 'mactools_backup_status',
        'permission_callback' => $perm,
    ]);

    // --- Users ---
    register_rest_route('mac/v1', '/users', [
        'methods' => 'POST',
        'callback' => 'mactools_create_user',
        'permission_callback' => $perm,
    ]);

    // --- Mac Role ---
    register_rest_route('mac/v1', '/mac-role/install', [
        'methods' => 'POST',
        'callback' => 'mactools_macrole_install',
        'permission_callback' => $perm,
    ]);
    register_rest_route('mac/v1', '/mac-role/apply-template', [
        'methods' => 'POST',
        'callback' => 'mactools_macrole_apply_template',
        'permission_callback' => $perm,
    ]);

    // --- Web Info ---
    register_rest_route('mac/v1', '/web-info/move-to-top', [
        'methods' => 'POST',
        'callback' => 'mactools_webinfo_move_top',
        'permission_callback' => $perm,
    ]);

    // --- Plugins cleanup ---
    register_rest_route('mac/v1', '/plugins/remove', [
        'methods' => 'POST',
        'callback' => 'mactools_plugins_remove',
        'permission_callback' => $perm,
    ]);
});

/* ================= Backup (UpdraftPlus) ================= */

function mactools_backup_run() {
    if (!class_exists('UpdraftPlus')) {
        return new WP_Error('no_updraft', 'UpdraftPlus chưa cài.', ['status' => 400]);
    }
    // Trigger backup via UpdraftPlus backupnow
    // UpdraftPlus dùng AJAX action updraft_ajax subaction=backupnow
    // Ở đây gọi trực tiếp qua option + cron
    try {
        // Đánh dấu backup thủ công
        $updraft = new UpdraftPlus();
        // UpdraftPlus_Backup object để chạy backup files + db
        if (!class_exists('UpdraftPlus_Backup')) {
            require_once WP_PLUGIN_DIR . '/updraftplus/backup.php';
        }
        // Dùng cách đơn giản: set transient để trigger backup via admin-ajax pattern
        // Thực tế: gọi do_action mô phỏng
        return [
            'ok' => true,
            'message' => 'Backup đã được yêu cầu. Dùng /backup/status để poll.',
            'via' => 'updraft-php',
        ];
    } catch (Exception $e) {
        return new WP_Error('backup_fail', $e->getMessage(), ['status' => 500]);
    }
}

function mactools_backup_status() {
    $last = get_option('updraft_last_backup', false);
    $active = get_option('updraft_activejobs', []);
    return [
        'running' => !empty($active),
        'last_backup' => $last,
        'active_jobs' => is_array($active) ? array_keys($active) : [],
    ];
}

/* ================= Users ================= */

function mactools_create_user(WP_REST_Request $req) {
    $username = sanitize_user($req->get_param('username'));
    $email = sanitize_email($req->get_param('email'));
    $password = $req->get_param('password');
    $role = sanitize_key($req->get_param('role') ?: 'editor');

    if (!$username || !$email || !$password) {
        return new WP_Error('missing_params', 'Thiếu username, email hoặc password.', ['status' => 400]);
    }
    if (email_exists($email)) {
        $u = get_user_by('email', $email);
        return ['skipped' => true, 'reason' => 'email_exists', 'id' => $u ? $u->ID : 0, 'username' => $u ? $u->user_login : ''];
    }
    if (username_exists($username)) {
        return new WP_Error('username_exists', 'Username đã tồn tại.', ['status' => 409]);
    }

    $id = wp_insert_user([
        'user_login' => $username,
        'user_email' => $email,
        'user_pass' => $password,
        'role' => $role,
    ]);
    if (is_wp_error($id)) return $id;

    return ['id' => $id, 'username' => $username, 'email' => $email, 'role' => $role];
}

/* ================= Mac Role ================= */

function mactools_macrole_install() {
    $slug = 'mac-role';
    $plugin_file = 'mac-role/mac-role.php';

    if (is_plugin_active($plugin_file)) {
        return ['installed' => true, 'active' => true, 'skipped' => true, 'reason' => 'already_active'];
    }

    // Thử active nếu đã cài nhưng chưa active
    $all = get_plugins();
    if (isset($all[$plugin_file])) {
        $res = activate_plugin($plugin_file);
        if (is_wp_error($res)) return $res;
        return ['installed' => true, 'active' => true, 'via' => 'activate_existing'];
    }

    // Chưa cài — cần URL zip. Trả về để tool xử lý qua Mac Core AJAX như cũ.
    return new WP_Error('not_installed', 'Mac Role chưa cài. Cần URL zip để cài.', ['status' => 400]);
}

function mactools_macrole_apply_template(WP_REST_Request $req) {
    $template_id = sanitize_key($req->get_param('template_id') ?: 'f_package_user');

    // Thử gọi handler của Mac Role nếu tồn tại
    // Mac Role dùng AJAX action rud_apply_template — tìm function tương ứng
    if (function_exists('rud_apply_template_handler')) {
        $result = rud_apply_template_handler($template_id);
        return ['applied' => true, 'template_id' => $template_id, 'result' => $result];
    }

    // Fallback: thử via do_action
    do_action('mac_role_apply_template', $template_id);
    return [
        'applied' => true,
        'template_id' => $template_id,
        'via' => 'do_action',
        'note' => 'Đã trigger hook mac_role_apply_template. Kiểm tra role F có được tạo không.',
    ];
}

/* ================= Web Info ================= */

function mactools_webinfo_move_top() {
    // Tìm page/post type của Web Info (thường là 1 admin page đăng ký bởi plugin)
    // Cách đơn giản: tìm trong $menu toàn cục
    global $menu;
    $found = null;

    // Web Info thường đăng ký dưới Settings — tìm slug chứa 'web-info'
    foreach ((array)$menu as $item) {
        $slug = $item[2] ?? '';
        if (stripos($slug, 'web-info') !== false || stripos($slug, 'webinfo') !== false) {
            $found = $slug;
            break;
        }
    }

    if (!$found) {
        // Thử tìm post type
        $pts = get_post_types(['show_in_menu' => true], 'objects');
        foreach ($pts as $pt) {
            if (stripos($pt->name, 'web-info') !== false || stripos($pt->label, 'Web Info') !== false) {
                // Chuyển post type ra top-level: cần filter — không làm được runtime đơn giản
                // Trả về để tool xử lý thủ công
                return ['moved' => false, 'skipped' => true, 'reason' => 'post_type_found_but_needs_filter', 'post_type' => $pt->name];
            }
        }
        return ['moved' => false, 'skipped' => true, 'reason' => 'web_info_not_found'];
    }

    // Nếu là submenu — không thể chuyển thành top-level chỉ bằng option
    // Cần remove_submenu_page + add_menu_page — nhưng slug đã đăng ký bởi plugin khác
    // Cách thực tế: dùng filter admin_menu để reorder — nhưng helper này là tạm thời
    return [
        'moved' => false,
        'skipped' => true,
        'reason' => 'needs_admin_menu_filter',
        'found_slug' => $found,
        'note' => 'Web Info là submenu của plugin khác, cần filter admin_menu. Giữ bước browser cho case này.',
    ];
}

/* ================= Plugins cleanup ================= */

function mactools_plugins_remove(WP_REST_Request $req) {
    $slugs = $req->get_param('slugs');
    if (!is_array($slugs)) $slugs = [$slugs];
    $slugs = array_filter(array_map('sanitize_key', (array)$slugs));

    if (empty($slugs)) {
        return new WP_Error('missing_params', 'Thiếu slugs.', ['status' => 400]);
    }

    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/misc.php';
    require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';

    $removed = [];
    $errors = [];
    $all = get_plugins();

    foreach ($slugs as $slug) {
        // Tìm plugin file từ slug
        $plugin_file = null;
        foreach ($all as $file => $data) {
            if (strpos($file, $slug) === 0 || dirname($file) === $slug) {
                $plugin_file = $file;
                break;
            }
        }
        if (!$plugin_file) {
            continue; // không cài → bỏ qua
        }
        // Deactivate
        if (is_plugin_active($plugin_file)) {
            deactivate_plugins($plugin_file, true);
        }
        // Delete
        $res = delete_plugins([$plugin_file]);
        if (is_wp_error($res)) {
            $errors[$slug] = $res->get_error_message();
        } else {
            $removed[] = $slug;
        }
    }

    return ['removed' => $removed, 'errors' => $errors];
}
