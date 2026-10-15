<?php
/**
 * Plugin Name: QR Bridge (tạm — tự xóa sau mỗi job)
 * Description: Expose _elementor_data qua REST cho MAC-Tools QR Tool. File này tự động bị xóa sau khi job xong.
 * Version: 1.0.0
 */

// Chặn truy cập trực tiếp
if (!defined('ABSPATH')) exit;

// Endpoint: GET /wp-json/qr/v1/template/{id} → _elementor_data
add_action('rest_api_init', function () {
    register_rest_route('qr/v1', '/template/(?P<id>\d+)', [
        'methods' => 'GET',
        'callback' => function ($req) {
            $id = (int) $req['id'];
            $data = get_post_meta($id, '_elementor_data', true);
            if (empty($data)) {
                return new WP_Error('no_data', 'Không có _elementor_data', ['status' => 404]);
            }
            $decoded = json_decode($data, true);
            return [
                'id' => $id,
                'elementor_data' => $decoded !== null ? $decoded : $data,
            ];
        },
        'permission_callback' => function () {
            return current_user_can('edit_pages');
        },
    ]);

    // Endpoint: POST /wp-json/qr/v1/regenerate-css/{id} → xóa _elementor_css để force regenerate
    register_rest_route('qr/v1', '/regenerate-css/(?P<id>\d+)', [
        'methods' => 'POST',
        'callback' => function ($req) {
            $id = (int) $req['id'];
            delete_post_meta($id, '_elementor_css');
            // Xóa file CSS trong uploads/elementor/css nếu có
            $upload_dir = wp_upload_dir();
            $css_file = trailingslashit($upload_dir['basedir']) . "elementor/css/post-{$id}.css";
            if (file_exists($css_file)) unlink($css_file);
            return ['ok' => true, 'id' => $id];
        },
        'permission_callback' => function () {
            return current_user_can('edit_pages');
        },
    ]);
});
