namespace UI.Extensions;

public static class StreamExtension
{
    public static async Task<byte[]> ReadAllBytes(this Stream stream)
    {
        using (var memoryStream = new MemoryStream())
        {
            await stream.CopyToAsync(memoryStream);
            return memoryStream.ToArray();
        }
    }
}