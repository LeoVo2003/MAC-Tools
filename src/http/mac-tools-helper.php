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
 *   POST /mac/v1/plugins/install          — cài plugin từ WordPress.org
 *   POST /mac/v1/plugins/activate         — activate plugin
 *   POST /mac/v1/options/set               — set WordPress option
 *   GET  /mac/v1/options/get               — get WordPress option
 *   POST /mac/v1/mac-role/grant-capabilities — bật Grant WP capabilities
 *   POST /mac/v1/mac-role/install-from-crm  — cài Mac Role từ WPM CRM API
 *
 * Auth: Application Password (Basic Auth) của admin.
 */

if (!defined('ABSPATH')) exit;

add_action('rest_api_init', function () {
    $perm = function () {
        return current_user_can('manage_options');
    };

    // Version check
    register_rest_route('mac/v1', '/version', [
        'methods' => 'GET',
        'callback' => function () {
            return ['version' => '1.0.5', 'endpoints' => 14];
        },
        'permission_callback' => $perm,
    ]);

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
    register_rest_route('mac/v1', '/plugins/install', [
        'methods' => 'POST',
        'callback' => 'mactools_plugins_install',
        'permission_callback' => $perm,
    ]);
    register_rest_route('mac/v1', '/plugins/activate', [
        'methods' => 'POST',
        'callback' => 'mactools_plugins_activate',
        'permission_callback' => $perm,
    ]);

    // --- Options (generic) ---
    register_rest_route('mac/v1', '/options/set', [
        'methods' => 'POST',
        'callback' => 'mactools_options_set',
        'permission_callback' => $perm,
    ]);
    register_rest_route('mac/v1', '/options/get', [
        'methods' => 'GET',
        'callback' => 'mactools_options_get',
        'permission_callback' => $perm,
    ]);

    // --- Mac Role settings ---
    register_rest_route('mac/v1', '/mac-role/grant-capabilities', [
        'methods' => 'POST',
        'callback' => 'mactools_macrole_grant_capabilities',
        'permission_callback' => $perm,
    ]);
    register_rest_route('mac/v1', '/mac-role/install-from-crm', [
        'methods' => 'POST',
        'callback' => 'mactools_macrole_install_from_crm',
        'permission_callback' => $perm,
    ]);
});

/* ================= Backup (UpdraftPlus) ================= */

function mactools_backup_run(WP_REST_Request $request) {
    // Nhận nonce từ client (Node đã lấy từ browser)
    $nonce = $request->get_param('nonce');

    if (!$nonce) {
        return new WP_Error('no_nonce', 'Thiếu nonce. Client phải gửi nonce từ trang UpdraftPlus.', ['status' => 400]);
    }

    // Lấy cookies để gọi AJAX với quyền admin
    $cookies = [];
    foreach ($_COOKIE as $k => $v) {
        $cookies[] = "$k=$v";
    }

    // Gọi backup via AJAX nội bộ
    $ajax_url = admin_url('admin-ajax.php');
    $resp = wp_remote_post($ajax_url, [
        'timeout' => 30,
        'sslverify' => false,
        'headers' => ['Cookie' => implode('; ', $cookies)],
        'body' => [
            'action' => 'updraft_ajax',
            'subaction' => 'backupnow',
            'nonce' => $nonce,
        ],
    ]);

    if (is_wp_error($resp)) {
        return new WP_Error('ajax_fail', $resp->get_error_message(), ['status' => 500]);
    }

    $body = wp_remote_retrieve_body($resp);
    $data = json_decode($body, true);

    // UpdraftPlus trả về {"nonce": "...", "m": "<strong>Start backup:</strong> OK..."}
    // hoặc {"job_id": "..."} tùy version
    if (isset($data['job_id'])) {
        return ['ok' => true, 'job_id' => $data['job_id'], 'via' => 'rest-ajax'];
    }
    // Kiểm tra message có "Start backup" + "OK"
    $msg = $data['m'] ?? $body;
    if (stripos($msg, 'Start backup') !== false && stripos($msg, 'OK') !== false) {
        return ['ok' => true, 'job_id' => $data['nonce'] ?? 'started', 'via' => 'rest-ajax', 'message' => strip_tags($msg)];
    }

    return new WP_Error('backup_fail', 'Response: ' . substr($body, 0, 200), ['status' => 500]);
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
    // NOTE: Nếu Web Info là JetEngine options page, thử tìm và update meta
    $pages = get_posts([
        'post_type' => 'jet-engine-options-pages',
        'posts_per_page' => -1,
        'post_status' => 'publish',
    ]);
    foreach ($pages as $p) {
        if (stripos($p->post_title, 'Web Info') !== false) {
            $meta = get_post_meta($p->ID);
            return [
                'moved' => false,
                'reason' => 'jetengine_found',
                'page_id' => $p->ID,
                'page_title' => $p->post_title,
                'meta_keys' => array_keys($meta),
                'note' => 'Tìm thấy JetEngine Web Info. Gửi meta_keys để xác định key cho menu position.',
            ];
        }
    }
    return [
        'moved' => false,
        'skipped' => true,
        'reason' => 'needs_admin_menu_filter',
        'found_slug' => $found,
        'note' => 'Web Info là submenu của plugin khác, cần filter admin_menu. Giữ bước browser cho case này.',
    ];
}

/* ================= Plugins install/activate ================= */

function mactools_plugins_install(WP_REST_Request $req) {
    $slug = sanitize_key($req->get_param('slug'));
    if (!$slug) {
        return new WP_Error('missing_params', 'Thiếu slug.', ['status' => 400]);
    }

    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/misc.php';
    require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
    require_once ABSPATH . 'wp-admin/includes/plugin-install.php';

    // Kiểm tra đã cài chưa
    $all = get_plugins();
    foreach ($all as $file => $data) {
        if (strpos($file, $slug) === 0 || dirname($file) === $slug) {
            return ['installed' => true, 'skipped' => true, 'reason' => 'already_installed', 'file' => $file];
        }
    }

    // Lấy thông tin plugin từ WordPress.org
    $api = plugins_api('plugin_information', ['slug' => $slug, 'fields' => ['download_link' => true]]);
    if (is_wp_error($api) || empty($api->download_link)) {
        return new WP_Error('not_found', "Không tìm thấy plugin '{$slug}' trên WordPress.org.", ['status' => 404]);
    }

    // Cài bằng Plugin_Upgrader
    $upgrader = new Plugin_Upgrader(new WP_Ajax_Upgrader_Skin());
    $result = $upgrader->install($api->download_link);
    if (is_wp_error($result)) return $result;
    if (!$result) {
        return new WP_Error('install_fail', "Cài plugin '{$slug}' thất bại.", ['status' => 500]);
    }

    // Tìm plugin file sau khi cài
    $plugin_file = $upgrader->plugin_info();
    return ['installed' => true, 'file' => $plugin_file ?: "{$slug}/{$slug}.php"];
}

function mactools_plugins_activate(WP_REST_Request $req) {
    $slug = sanitize_key($req->get_param('slug'));
    $file = sanitize_text_field($req->get_param('file') ?: '');
    if (!$slug && !$file) {
        return new WP_Error('missing_params', 'Thiếu slug hoặc file.', ['status' => 400]);
    }

    require_once ABSPATH . 'wp-admin/includes/plugin.php';

    // Tìm plugin file từ slug nếu chưa có
    $plugin_file = $file;
    if (!$plugin_file) {
        $all = get_plugins();
        foreach ($all as $f => $data) {
            if (strpos($f, $slug) === 0 || dirname($f) === $slug) {
                $plugin_file = $f;
                break;
            }
        }
    }
    if (!$plugin_file) {
        return new WP_Error('not_installed', "Plugin '{$slug}' chưa cài.", ['status' => 400]);
    }
    if (is_plugin_active($plugin_file)) {
        return ['active' => true, 'skipped' => true, 'reason' => 'already_active', 'file' => $plugin_file];
    }

    $res = activate_plugin($plugin_file);
    if (is_wp_error($res)) return $res;
    return ['active' => true, 'file' => $plugin_file];
}

/* ================= Options (generic) ================= */

function mactools_options_set(WP_REST_Request $req) {
    $key = sanitize_key($req->get_param('key'));
    $value = $req->get_param('value');
    if (!$key) {
        return new WP_Error('missing_params', 'Thiếu key.', ['status' => 400]);
    }
    // Chỉ cho phép các option an toàn (không phải core sensitive)
    $blocked = ['siteurl', 'home', 'admin_email', 'users_can_register'];
    if (in_array($key, $blocked, true)) {
        return new WP_Error('blocked', "Option '{$key}' bị chặn.", ['status' => 403]);
    }
    update_option($key, $value);
    return ['ok' => true, 'key' => $key];
}

function mactools_options_get(WP_REST_Request $req) {
    $key = sanitize_key($req->get_param('key'));
    if (!$key) {
        return new WP_Error('missing_params', 'Thiếu key.', ['status' => 400]);
    }
    return ['key' => $key, 'value' => get_option($key)];
}

/* ================= Mac Role: Grant capabilities ================= */

function mactools_macrole_grant_capabilities() {
    // Mac Role lưu setting này dạng option đơn: rud_grant_caps_for_allowed_urls = 1
    // (thấy trong admin/class-admin-pages.php dòng 271-272)
    update_option('rud_grant_caps_for_allowed_urls', 1);

    $val = get_option('rud_grant_caps_for_allowed_urls');
    return [
        'ok' => (int)$val === 1,
        'option' => 'rud_grant_caps_for_allowed_urls',
        'value' => (int)$val,
        'via' => 'update_option',
    ];
}

/* ================= Mac Role: install từ CRM (WPM API) ================= */

function mactools_macrole_install_from_crm(WP_REST_Request $req) {
    $slug = sanitize_key($req->get_param('slug') ?: 'mac-role');

    // Kiểm tra đã cài chưa
    require_once ABSPATH . 'wp-admin/includes/plugin.php';
    $all = get_plugins();
    foreach ($all as $file => $data) {
        if (strpos($file, $slug) === 0 || dirname($file) === $slug) {
            if (is_plugin_active($file)) {
                return ['installed' => true, 'active' => true, 'skipped' => true, 'reason' => 'already_active', 'file' => $file];
            }
            $res = activate_plugin($file);
            if (is_wp_error($res)) return $res;
            return ['installed' => true, 'active' => true, 'file' => $file, 'via' => 'activate_existing'];
        }
    }

    // Chưa cài — tải từ CRM (WPM API), giống Mac Core
    $license_key = get_option('mac_domain_valid_key', '');
    if (!$license_key) {
        return new WP_Error('no_license', 'Thiếu mac_domain_valid_key — không tải được từ CRM.', ['status' => 400]);
    }
    $site_url = get_site_url() . '/';
    $api_url = 'https://wpm.macusaone.com/api/v1/plugins/' . rawurlencode($slug);

    $resp = wp_remote_post($api_url, [
        'method' => 'POST',
        'timeout' => 30,
        'sslverify' => true,
        'headers' => ['Content-Type' => 'application/x-www-form-urlencoded', 'Accept' => 'application/json'],
        'body' => ['key' => $license_key, 'url' => $site_url, 'action' => 'download', 'slug' => $slug],
    ]);
    if (is_wp_error($resp)) {
        return new WP_Error('crm_fail', 'CRM request thất bại: ' . $resp->get_error_message(), ['status' => 500]);
    }
    $code = wp_remote_retrieve_response_code($resp);
    $body = wp_remote_retrieve_body($resp);
    $data = json_decode($body, true);
    if ($code !== 200 || empty($data['download_url'])) {
        return new WP_Error('crm_no_url', 'CRM không trả download_url (HTTP ' . $code . ').', ['status' => 500]);
    }

    // Download + cài
    require_once ABSPATH . 'wp-admin/includes/file.php';
    require_once ABSPATH . 'wp-admin/includes/misc.php';
    require_once ABSPATH . 'wp-admin/includes/class-wp-upgrader.php';
    if (!function_exists('download_url')) {
        require_once ABSPATH . 'wp-admin/includes/file.php';
    }
    $tmp = download_url($data['download_url']);
    if (is_wp_error($tmp)) return $tmp;

    $upgrader = new Plugin_Upgrader(new WP_Ajax_Upgrader_Skin());
    $result = $upgrader->install($tmp);
    @unlink($tmp);
    if (is_wp_error($result)) return $result;
    if (!$result) {
        return new WP_Error('install_fail', 'Cài plugin thất bại.', ['status' => 500]);
    }

    $plugin_file = $upgrader->plugin_info();
    if (!$plugin_file) {
        // Tìm file sau khi cài
        $all2 = get_plugins();
        foreach ($all2 as $f => $d) {
            if (strpos($f, $slug) === 0 || dirname($f) === $slug) {
                $plugin_file = $f;
                break;
            }
        }
    }
    if ($plugin_file && !is_plugin_active($plugin_file)) {
        $res = activate_plugin($plugin_file);
        if (is_wp_error($res)) return $res;
    }

    return ['installed' => true, 'active' => true, 'file' => $plugin_file, 'via' => 'crm'];
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
