# Install:
# pip install --upgrade "volcengine-python-sdk[ark]"

import os 
# 通过 pip install 'volcengine-python-sdk[ark]' 安装方舟SDK 
from volcenginesdkarkruntime import Ark

# 请确保您已将 API Key 存储在环境变量 ARK_API_KEY 中 
# 初始化Ark客户端，从环境变量中读取您的API Key 
client = Ark( 
    # 此为默认路径，您可根据业务所在地域进行配置 
    base_url="https://ark.cn-beijing.volces.com/api/v3", 
    # 从环境变量中获取您的 API Key。此为默认方式，您可根据需要进行修改 
    api_key=os.environ.get("ARK_API_KEY"), 
) 
 
imagesResponse = client.images.generate( 
    model="ep-20260917151237-rwqtz", 
    prompt="将图1的服装换为图2的服装",
    image=["https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imagesToimage_1.png", "https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imagesToimage_2.png"],
    sequential_image_generation="disabled",
    response_format="url",
    size="2K",
    stream=False,
    watermark=True
) 
 
print(imagesResponse.data[0].url)