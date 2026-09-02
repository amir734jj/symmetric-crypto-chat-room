FROM mcr.microsoft.com/dotnet/sdk:8.0-alpine AS build
WORKDIR /src
COPY . .
RUN dotnet publish API/API.csproj -c Release -o /out/api \
    && dotnet publish UI/UI.csproj -c Release -o /out/ui \
    && cp -r /out/ui/wwwroot /out/api/

FROM mcr.microsoft.com/dotnet/aspnet:8.0-alpine
ENV DOTNET_SYSTEM_GLOBALIZATION_INVARIANT=1 \
    DOTNET_EnableDiagnostics=0 \
    ASPNETCORE_URLS=http://+:3000

EXPOSE 3000

WORKDIR /app
COPY --from=build /out/api .

ENTRYPOINT ["dotnet", "API.dll"]
