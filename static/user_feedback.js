// ================================
// 🚗 DriveBuddy ユーザーフィードバック送信処理
// ================================

document.addEventListener("DOMContentLoaded", () => {
  // ===============================
  // 🔧 Firebase 初期化
  // ===============================
  const firebaseConfig = {
    apiKey: "AIzaSyCEuouICKd32x3-4y5QzA_2ovq8pydvez4",
    authDomain: "drive-prototype-32ef0.firebaseapp.com",
    projectId: "drive-prototype-32ef0",
    storageBucket: "drive-prototype-32ef0.firebasestorage.app",
    messagingSenderId: "500916744769",
    appId: "1:500916744769:web:d5a529ef05d15bb2934cc0"
  };
  if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
  const db = firebase.firestore();
  const storage = firebase.storage();

  // ===============================
  // 🧩 要素取得
  // ===============================
  const form = document.getElementById("feedbackForm");
  const successMessage = document.getElementById("successMessage");
  const newFeedbackBtn = document.getElementById("newFeedbackBtn");
  const stars = document.querySelectorAll("#rating span");

  let selectedRating = 0;

  // ===============================
  // ⭐ 星評価クリック処理
  // ===============================
  stars.forEach(star => {
    star.addEventListener("click", () => {
      selectedRating = parseInt(star.getAttribute("data-value"));
      stars.forEach(s => s.classList.remove("active"));
      for (let i = 0; i < selectedRating; i++) {
        stars[i].classList.add("active");
      }
    });
  });

  // ===============================
  // 🚀 フォーム送信処理
  // ===============================
  form.addEventListener("submit", async (e) => {
    e.preventDefault();

    // 入力値取得
    const username = document.getElementById("username").value.trim();
    const recordDates = document.getElementById("recordDates").value.trim();
    const goodPoints = document.getElementById("goodPoints").value.trim();
    const improvements = document.getElementById("improvements").value.trim();
    const futureFeatures = document.getElementById("futureFeatures").value.trim();
    const other = document.getElementById("other").value.trim();

    // チェックボックス取得
    const timeChecks = [];
    document.querySelectorAll("input[type=checkbox]:checked").forEach(cb => timeChecks.push(cb.value));

    // ファイル取得
    const imageFiles = document.getElementById("images").files;

    // 必須項目チェック
    if (!username || !recordDates || timeChecks.length === 0 || selectedRating === 0) {
      alert("必須項目を入力してください。");
      return;
    }

    try {
      // ===== Firestoreへデータ保存 =====
      const timestamp = Date.now();
      const feedbackRef = db.collection("feedbacks").doc();

        const feedbackData = {
            user_id: window.FLASK_USER_ID || "anonymous",        // ← ログインID
            user_name: window.FLASK_USER_NAME || username,       // ← ユーザー名（自動）
            form_name: username,                                 // ← フォームで入力した名前
            undou_bi: recordDates,                               // ← 運転を記録した日
            undou_jikantai: timeChecks,                          // ← 運転した時間帯
            manzokudo: selectedRating,                           // ← 満足度（1〜5）
            yokatta_ten: goodPoints,                             // ← 良かった点
            kaizen_ten: improvements,                            // ← 改善点
            tsuika_kinou: futureFeatures,                        // ← 今後追加してほしい機能
            sonota: other,                                       // ← その他
            sakuseibi: new Date(),                               // ← 送信日時
        };


      await feedbackRef.set(feedbackData);
      console.log("✅ Firestore保存完了");

      // ===== Storageに画像アップロード =====
      if (imageFiles.length > 0) {
        const uploadPromises = [];
        const urls = [];

        for (let i = 0; i < imageFiles.length && i < 5; i++) {
          const file = imageFiles[i];
          const filePath = `feedback_images/${feedbackData.user_id}/${timestamp}_${file.name}`;
          const storageRef = storage.ref(filePath);

          const uploadTask = storageRef.put(file);
          uploadPromises.push(
            uploadTask.then(() =>
              storageRef.getDownloadURL().then(url => urls.push(url))
            )
          );
        }

        await Promise.all(uploadPromises);
        await feedbackRef.update({ image_urls: urls });
        console.log("📸 画像アップロード完了");
      }

      // ===== 完了UI表示 =====
      form.style.display = "none";
      successMessage.style.display = "block";

    } catch (err) {
      console.error("❌ フィードバック送信エラー:", err);
      alert("送信中にエラーが発生しました。もう一度お試しください。");
    }
  });

  // ===============================
  // 🔁 「もう一度回答する」ボタン
  // ===============================
  newFeedbackBtn.addEventListener("click", () => {
    form.reset();
    form.style.display = "block";
    successMessage.style.display = "none";
    selectedRating = 0;
    stars.forEach(s => s.classList.remove("active"));
  });
});
