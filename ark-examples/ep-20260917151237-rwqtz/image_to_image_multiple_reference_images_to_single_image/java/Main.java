// Install:
// <dependency>
//   <groupId>com.volcengine</groupId>
//   <artifactId>volcengine-java-sdk-ark-runtime</artifactId>
//   <version>LATEST</version>
// </dependency>

package com.volcengine.ark.runtime;

import com.volcengine.ark.runtime.model.images.generation.GenerateImagesRequest;
import com.volcengine.ark.runtime.model.images.generation.ImagesResponse;
import com.volcengine.ark.runtime.model.images.generation.ResponseFormat;
import com.volcengine.ark.runtime.model.images.generation.Size;
import com.volcengine.ark.runtime.service.ArkService;
import okhttp3.ConnectionPool;
import okhttp3.Dispatcher;

import java.util.Arrays; 
import java.util.List; 
import java.util.concurrent.TimeUnit;

public class ImageGenerationsExample { 
    public static void main(String[] args) {
        String apiKey = System.getenv("ARK_API_KEY");
        ConnectionPool connectionPool = new ConnectionPool(5, 1, TimeUnit.SECONDS);
        Dispatcher dispatcher = new Dispatcher();
        ArkService service = ArkService.builder().dispatcher(dispatcher).connectionPool(connectionPool).apiKey(apiKey).build();

        GenerateImagesRequest generateRequest = GenerateImagesRequest.builder()
                .model("ep-20260917151237-rwqtz")
                .prompt("将图1的服装换为图2的服装")
                .image(Arrays.asList(
                    "https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imagesToimage_1.png",
                    "https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imagesToimage_2.png"
                ))
                .size("2K")
                .sequentialImageGeneration("disabled")
                .responseFormat(ResponseFormat.Url)
                .stream(false)
                .watermark(true)
                .build();
        
        ImagesResponse imagesResponse = service.generateImages(generateRequest);
        System.out.println(imagesResponse.getData().get(0).getUrl());

        service.shutdownExecutor();
    }
}