# AI 模型

這些模型都在手機瀏覽器上執行（onnxruntime-web），照片不會上傳。

| 檔案 | 用途 | 來源 | 授權 |
|---|---|---|---|
| `plate-detector-yolov9t-640.onnx` | 找出照片中的車牌位置 | [open-image-models](https://github.com/ankandrew/open-image-models) 的 `yolo-v9-t-640-license-plates-end2end.onnx` | MIT |
| `plate-detector-yolov9t-384.onnx` | 找出車牌位置（快速版，iPhone 即時辨識用） | [open-image-models](https://github.com/ankandrew/open-image-models) 的 `yolo-v9-t-384-license-plates-end2end.onnx` | MIT |
| `plate-ocr-cct-s-v2.onnx` | 讀出車牌上的英數字 | [fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) 的 `cct_s_v2_global.onnx` | MIT |

## 模型規格

**車牌偵測**（384 版除了輸入尺寸為 384×384，其餘相同；CPU 上約快 2.7 倍）
- 輸入 `images`：float32 `[1, 3, 640, 640]`，RGB、數值 0～1，等比例縮放後周圍補灰色 (114,114,114)
- 輸出 `output0`：float32 `[N, 7]`，每列為 `[batch, x1, y1, x2, y2, class, score]`，模型內已做 NMS

**文字辨識**
- 輸入 `input`：uint8 `[N, 64, 128, 3]`，RGB，車牌裁切後直接拉伸成 128×64
- 輸出 `plate`：float32 `[N, 10, 37]`，10 個字元位置，字元集 `0-9A-Z_`（`_` 代表空位）

## 注意

- 文字辨識模型的訓練資料包含 65 個國家的車牌，**不包含台灣**。實際準確度需要用校園照片驗證，必要時再重新訓練。
- 更換模型時請**改檔名**（例如加上版本號），因為手機會一直使用快取中的舊檔案。

## 授權聲明

```
MIT License — Copyright (c) ankandrew
open-image-models: https://github.com/ankandrew/open-image-models
fast-plate-ocr:    https://github.com/ankandrew/fast-plate-ocr
```
