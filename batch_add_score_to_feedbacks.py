import os
from google.cloud import firestore
from ai_evaluation import get_focus_rating

def main():
    # Firestore初期化
    db = firestore.Client()
    sessions = db.collection("sessions").stream()
    updated_count = 0
    for session in sessions:
        session_id = session.id
        feedbacks_ref = db.collection("sessions").document(session_id).collection("focus_feedbacks")
        feedbacks = feedbacks_ref.stream()
        for fb_doc in feedbacks:
            fb_data = fb_doc.to_dict()
            if "score" in fb_data:
                continue  # 既にscoreがある場合はスキップ
            stats = fb_data.get("stats")
            focus_type = fb_data.get("focus_type")
            if not stats or not focus_type:
                continue
            # スコア算出（get_focus_ratingは(評価, スコア)を返す）
            try:
                _, score = get_focus_rating(stats, focus_type)
            except Exception as e:
                print(f"Error for session {session_id}, pin {fb_doc.id}: {e}")
                continue
            # Firestoreにscoreを追加
            feedbacks_ref.document(fb_doc.id).update({"score": score})
            updated_count += 1
            print(f"Updated score for session {session_id}, pin {fb_doc.id}: {score}")
    print(f"完了: {updated_count}件のフィードバックにscoreを付与しました")

if __name__ == "__main__":
    main()
