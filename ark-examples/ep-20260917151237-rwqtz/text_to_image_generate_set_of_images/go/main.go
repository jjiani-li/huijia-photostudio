// Install:
// go get -u github.com/volcengine/volcengine-go-sdk

package main

import (
    "context"
    "fmt"
    "os"
    "strings"
    
    "github.com/volcengine/volcengine-go-sdk/service/arkruntime"
    "github.com/volcengine/volcengine-go-sdk/service/arkruntime/model"
    "github.com/volcengine/volcengine-go-sdk/volcengine"
)

func main() {
    client := arkruntime.NewClientWithApiKey(os.Getenv("ARK_API_KEY"))
    ctx := context.Background()
    
    var sequentialImageGeneration model.SequentialImageGeneration = "auto"
    maxImages := 4
    generateReq := model.GenerateImagesRequest{
       Model:          "ep-20260917151237-rwqtz",
       Prompt:         "生成一组共4张连贯插画，核心为同一庭院一角的四季变迁，以统一风格展现四季独特色彩、元素与氛围",
       Size:           volcengine.String("2K"),
       ResponseFormat: volcengine.String(model.GenerateImagesResponseFormatURL),
       Watermark:      volcengine.Bool(true),
       SequentialImageGeneration: &sequentialImageGeneration,
       SequentialImageGenerationOptions: &model.SequentialImageGenerationOptions{
          MaxImages: &maxImages,
       },
    }

    stream, err := client.GenerateImagesStreaming(ctx, generateReq)
        if err != nil {
                fmt.Printf("call GenerateImagesStreaming error: %v\n", err)
                return
        }

        defer stream.Close()

        for {
                recv, err := stream.Recv()
                if err == io.EOF {
                        break
                }
                if err != nil {
                        fmt.Printf("Stream generate images error: %v\n", err)
                        break
                }

                if recv.Type == "image_generation.partial_failed" {
                        fmt.Printf("Stream generate images error: %v\n", recv.Error)
                        if strings.EqualFold(recv.Error.Code, "InternalServiceError") {
                                break
                        }
                }

                if recv.Type == "image_generation.partial_succeeded" {
                        if recv.Error == nil && recv.Url != nil {
                                fmt.Printf("recv.Size: %s, recv.Url: %s\n", recv.Size, *recv.Url)
                        }
                }

                if recv.Type == "image_generation.completed" {
                        if recv.Error == nil {
                                fmt.Printf("recv.Usage: %v\n", *recv.Usage)
                        }
                }
        }
}