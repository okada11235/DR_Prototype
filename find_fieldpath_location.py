import importlib
import inspect
import pkgutil

def find_fieldpath_location():
    try:
        # まず google.cloud.firestore モジュールを探す
        firestore_pkg = importlib.import_module("google.cloud.firestore")
        print("✅ 'google.cloud.firestore' は読み込めました")
    except ImportError as e:
        print("❌ 'google.cloud.firestore' が見つかりません:", e)
        return

    print("\n🔍 FieldPath の定義場所を探しています...\n")

    # Firestore配下のすべてのサブモジュールを再帰的に探索
    for module_info in pkgutil.walk_packages(firestore_pkg.__path__, firestore_pkg.__name__ + "."):
        name = module_info.name
        try:
            mod = importlib.import_module(name)
            if hasattr(mod, "FieldPath"):
                print(f"🎯 見つかりました！ FieldPath は {name} にあります")
                print(f"📄 ファイル: {inspect.getfile(mod.FieldPath)}")
                return
        except Exception as e:
            # 読み込みエラーのモジュールはスキップ
            pass

    print("⚠️ FieldPath は見つかりませんでした。Firestore SDK のバージョンが古い可能性があります。")

if __name__ == "__main__":
    find_fieldpath_location()
