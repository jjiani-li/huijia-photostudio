curl -X POST https://ark.cn-beijing.volces.com/api/v3/images/generations \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $ARK_API_KEY" \
  -d '{
    "model": "ep-20260917134606-9qt4p",
    "prompt": "参考这个LOGO，做一套户外运动品牌视觉设计，品牌名称为GREEN，包括包装袋、帽子、纸盒、手环、挂绳等。绿色视觉主色调，趣味、简约现代风格",
    "image": "https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imageToimages.png",
    "sequential_image_generation": "auto",
    "sequential_image_generation_options": {
        "max_images": 5
    },
    "response_format": "url",
    "size": "2K",
    "stream": true,
    "watermark": true
}'