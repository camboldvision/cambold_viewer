/* SPDX-License-Identifier: Apache-2.0 */
#include "application.hpp"
#include <exception>
#include <iostream>

namespace
{

std::string arg_value(int argc, char **argv, const std::string &name, const std::string &fallback)
{
    for (int i = 1; i + 1 < argc; ++i)
        if (argv[i] == name)
            return argv[i + 1];
    return fallback;
}

} // namespace

int main(int argc, char **argv)
{
    try
    {
        cambold::viewer::ViewerApplication app(arg_value(argc, argv, "--control-port", ""),
                                               arg_value(argc, argv, "--debug-port", ""));
        app.run();
        return 0;
    }
    catch (const std::exception &error)
    {
        std::cerr << "CamBold Viewer error: " << error.what() << '\n';
        return 1;
    }
}
