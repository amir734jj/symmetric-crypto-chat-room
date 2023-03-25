namespace UI.Extensions;

public static class StreamExtension
{
    public static async Task<string> ConvertToBase64(this Stream stream)
    {
        byte[] bytes;
        using (var memoryStream = new MemoryStream())
        {
            await stream.CopyToAsync(memoryStream);
            bytes = memoryStream.ToArray();
        }

        var base64 = Convert.ToBase64String(bytes);
        return base64;
    }
}