// Cấu hình nút "Gửi cho tiệm in" (gửi ảnh sang máy tính của tiệm qua Wi-Fi).
// Chỉ sửa các giá trị bên dưới, không cần đụng vào file khác.
window.TUNIA_CONFIG = Object.assign({
  sendEnabled: true,          // false = ẩn nút "Gửi cho tiệm in"
  shopAddress: "",            // địa chỉ máy tính tiệm nếu cố định, ví dụ "192.168.1.50:8765" (để trống nếu khách quét mã QR trên máy tiệm)
  bridgeTimeoutMs: 15000,     // chờ máy tiệm trả lời tối đa bấy nhiêu mili-giây
}, window.TUNIA_CONFIG || {});
