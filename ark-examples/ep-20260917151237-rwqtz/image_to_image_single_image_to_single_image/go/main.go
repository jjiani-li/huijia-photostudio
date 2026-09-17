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

    generateReq := model.GenerateImagesRequest{
       Model:          "ep-20260917151237-rwqtz",
       Prompt:         "生成狗狗趴在草地上的近景画面",
       Image:          volcengine.String("https://ark-project.tos-cn-beijing.volces.com/doc_image/seedream4_imageToimage.png"),
       Size:           volcengine.String("2K"),
       ResponseFormat: volcengine.String(model.GenerateImagesResponseFormatURL),
       Watermark:      volcengine.Bool(true),
    }

    imagesResponse, err := client.GenerateImages(ctx, generateReq)
    if err != nil {
       fmt.Printf("generate images error: %v\n", err)
       return
    }

    fmt.Printf("%s\n", *imagesResponse.Data[0].Url)
}