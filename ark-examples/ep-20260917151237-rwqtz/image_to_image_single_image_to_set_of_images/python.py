# Install:
# pip install --upgrade "volcengine-python-sdk[ark]"

import os 
# 通过 pip install 'volcengine-python-sdk[ark]' 安装方舟SDK 
from volcenginesdkarkruntime import Ark 
from volcenginesdkarkruntime.types.images.images import SequentialImageGenerationOptions

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
    prompt="参考这个LOGO，做一套户外运动品牌视觉设计，品牌名称为GREEN，包括包装袋、帽子、纸盒、手环、挂绳等。绿色视觉主色调，趣味、简约现代风格",
    image="https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imageToimages.png",
    sequential_image_generation="auto",
    sequential_image_generation_options=SequentialImageGenerationOptions(max_images=5),
    response_format="url",
    size="2K",
    stream=True,
    watermark=True
) 
 
for event in imagesResponse:
    if event is None:
        continue
    if event.type == "image_generation.partial_failed":
        print(f"Stream generate images error: {event.error}")
        if event.error is not None and event.error.code.equal("InternalServiceError"):
            break
    elif event.type == "image_generation.partial_succeeded":
        if event.error is None and event.url:
            print(f"recv.Size: {event.size}, recv.Url: {event.url}")
    elif event.type == "image_generation.completed":
        if event.error is None:
            print("Final completed event:")
            print("recv.Usage:", event.usage)